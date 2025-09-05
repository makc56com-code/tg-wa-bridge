// index.js
import 'dotenv/config'
import express from 'express'
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import chalk from 'chalk'
import P from 'pino'
import { Boom } from '@hapi/boom'

// ---------------- Config (env) ----------------
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TG_SOURCE,               // username or id (without @)
  WA_GROUP_ID,             // either group id (xxxxx@g.us) or group name (case-insensitive) - prefer GROUP_NAME below
  WA_GROUP_NAME,           // optional: prefer searching by name
  PORT = 3000,
  GITHUB_TOKEN,
  GIST_ID,
  AUTH_DIR = '/tmp/auth_info_baileys' // writable temp dir on Render
} = process.env

// ensure AUTH_DIR exists
try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) { /* ignore */ }

// ---------------- Globals ----------------
let tgClient = null
let sock = null
let lastQR = null
let waConnectionStatus = 'disconnected' // disconnected | connecting | awaiting_qr | connected
let isStartingWA = false
let needAuthInProgress = false
let retryCount = 0
let retryTimer = null
let saveAuthTimer = null
let cachedGroupJid = null

const PLOGGER = P({ level: 'warn' }) // pino for Baileys key store
const UI_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`

// ---------------- Helpers: Gist load/save ----------------
async function loadAuthFromGistToDir(dir) {
  if (!GITHUB_TOKEN || !GIST_ID) return false
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      timeout: 15000
    })
    const files = res.data.files
    if (!files || Object.keys(files).length === 0) return false

    for (const [filename, fileObj] of Object.entries(files)) {
      const fp = path.join(dir, filename)
      fs.writeFileSync(fp, fileObj.content, 'utf8')
    }
    console.log(chalk.green('📥 Auth загружён из Gist в'), dir)
    return true
  } catch (err) {
    console.log(chalk.yellow('⚠️ Не удалось загрузить auth из Gist:'), err?.message || err)
    return false
  }
}

function debounceSaveAuthToGist(dir) {
  if (saveAuthTimer) clearTimeout(saveAuthTimer)
  saveAuthTimer = setTimeout(() => saveAuthToGist(dir).catch(()=>{}), 2500)
}

async function saveAuthToGist(dir) {
  if (!GITHUB_TOKEN || !GIST_ID) return
  try {
    if (!fs.existsSync(dir)) return
    const files = {}
    for (const file of fs.readdirSync(dir)) {
      const fp = path.join(dir, file)
      if (!fs.statSync(fp).isFile()) continue
      files[file] = { content: fs.readFileSync(fp, 'utf8') }
    }
    if (Object.keys(files).length === 0) return
    await axios.patch(`https://api.github.com/gists/${GIST_ID}`, { files }, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      timeout: 15000
    })
    console.log(chalk.green('💾 Auth сохранён в Gist'))
  } catch (err) {
    console.log(chalk.yellow('⚠️ Ошибка при сохранении auth в Gist:'), err?.message || err)
  }
}

// ---------------- Telegram ----------------
async function startTelegram() {
  console.log(chalk.cyan('🚀 Подключение к Telegram...'))
  try {
    tgClient = new TelegramClient(
      new StringSession(TELEGRAM_STRING_SESSION || ''),
      Number(TELEGRAM_API_ID),
      TELEGRAM_API_HASH,
      { connectionRetries: 5 }
    )
    await tgClient.connect()
    console.log(chalk.green('✅ Telegram подключён'))
    tgClient.addEventHandler(onTelegramMessage, new NewMessage({}))
  } catch (e) {
    console.error(chalk.red('❌ Ошибка Telegram:'), e)
    tgClient = null
  }
}

async function onTelegramMessage(event) {
  try {
    const message = event.message
    if (!message) return
    const sender = await message.getSender().catch(()=>null)
    const senderIdStr = sender?.id ? String(sender.id) : ''
    const senderUsername = sender?.username ? ('' + sender.username).replace(/^@/,'').toLowerCase() : ''
    const source = (TG_SOURCE || '').toString().replace(/^@/,'').toLowerCase()
    const isFromSource = source && (senderUsername === source || senderIdStr === source || ('-' + senderIdStr) === source)
    // Only forward textual content from the source
    let text = null
    if (message.message && typeof message.message === 'string') text = message.message
    else if (message.message?.message?.conversation) text = message.message.message.conversation
    else if (message.message?.message?.text) text = message.message.message.text
    if (isFromSource && text && text.toString().trim()) {
      console.log(chalk.blue('✉️ Получено из TG:'), text.toString().slice(0,200))
      await sendToWhatsApp(text.toString())
    }
  } catch (e){
    console.error(chalk.red('⚠️ Ошибка обработки TG event:'), e)
  }
}

// ---------------- WhatsApp (Baileys) ----------------
async function startWhatsApp({ reset = false } = {}) {
  if (isStartingWA) {
    console.log(chalk.gray('ℹ️ startWhatsApp called but isStartingWA=true → skipping'))
    return
  }
  isStartingWA = true
  waConnectionStatus = 'connecting'
  console.log(chalk.cyan('🚀 Запуск WhatsApp... (reset=' + !!reset + ')'))

  // ensure dir exists
  try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e){}

  if (reset) {
    // remove old local files to force new auth
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch(e){}
    lastQR = null
  }

  // try to load from gist into AUTH_DIR
  const loaded = await loadAuthFromGistToDir(AUTH_DIR).catch(()=>false)
  if (!loaded) console.log(chalk.yellow('⚠️ Сессия в Gist не найдена или не загружена — будет новая авторизация.'))

  // ensure dir exists again (useMultiFileAuthState will write files)
  try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e){}

  // create auth state and socket
  let state, saveCreds
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR))
  } catch (e) {
    console.error(chalk.red('❌ useMultiFileAuthState failed:'), e)
    isStartingWA = false
    scheduleRestart(false)
    return
  }

  let version = undefined
  try { const v = await fetchLatestBaileysVersion(); version = v.version } catch(e){ /* ignore */ }

  try {
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, PLOGGER)
      },
      logger: PLOGGER,
      browser: Browsers.appropriate('Render', 'Chrome'),
      printQRInTerminal: false
    })
  } catch (e) {
    console.error(chalk.red('❌ makeWASocket failed:'), e)
    isStartingWA = false
    scheduleRestart(false)
    return
  }

  // Save creds -> debounce -> gist
  sock.ev.on('creds.update', async () => {
    try { await saveCreds() } catch (e){ /* ignore */ }
    debounceSaveAuthToGist(AUTH_DIR)
  })

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr, isNewLogin } = update
      if (qr) {
        lastQR = qr
        waConnectionStatus = 'awaiting_qr'
        console.log(chalk.yellow('📱 QR сгенерирован — открой /qr или WebUI'))
      }
      if (connection === 'open') {
        waConnectionStatus = 'connected'
        retryCount = 0
        needAuthInProgress = false
        console.log(chalk.green('✅ WhatsApp подключён'))
        // sync local files to gist immediately (we likely loaded from gist, but ensure newest saved)
        debounceSaveAuthToGist(AUTH_DIR)
        // cache groups
        try { await cacheGroupId(true) } catch(e){ console.log('⚠️ cacheGroupId error:',e?.message||e) }
        isStartingWA = false
      } else if (connection === 'close') {
        waConnectionStatus = 'disconnected'
        isStartingWA = false
        // compute status code more defensively
        let statusCode = null
        try {
          statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
        } catch(e){ statusCode = lastDisconnect?.error?.output?.statusCode || null }
        console.log(chalk.red('⚠️ WhatsApp соединение закрыто'), statusCode || (lastDisconnect?.error && String(lastDisconnect.error).slice(0,150)) || '')
        // close socket reference safely
        try { await sock?.end?.() } catch(e) {}
        // handle specific cases
        if (statusCode === 401 || statusCode === 428) {
          // session invalid/expired; start auth-reset *once* (don't loop)
          if (!needAuthInProgress) {
            needAuthInProgress = true
            console.log(chalk.yellow('❌ Сессия недействительна — начнём новую авторизацию (generate QR)'))
            // schedule reset start after small delay to let previous socket close properly
            setTimeout(()=> startWhatsApp({ reset: true }), 1200)
          } else {
            console.log(chalk.gray('ℹ️ already in auth flow; skipping repeated reset'))
          }
        } else if (statusCode === 440 || statusCode === 409) {
          // conflict / stream errored — do not force immediate restart => small backoff
          scheduleRestart(true)
        } else {
          // generic errors — attempt restart with exponential backoff
          scheduleRestart(false)
        }
      }
    } catch (e) {
      console.error(chalk.red('⚠️ connection.update handler error:'), e)
      isStartingWA = false
      scheduleRestart(false)
    }
  })

  // messages.upsert logging (not used for forwarding here)
  sock.ev.on('messages.upsert', m => {
    // optional: debug small messages
    const text = m?.messages?.[0]?.message?.conversation || m?.messages?.[0]?.message?.extendedText?.text
    if (text) console.log(chalk.gray('📥 WA msg (preview):'), String(text).slice(0,120))
  })

  // connection error
  sock.ev.on('connection.error', e => {
    console.error(chalk.yellow('⚠️ connection.error:'), e?.message || e)
  })
}

// schedule restart with exponential backoff
function scheduleRestart(isShort=false) {
  if (retryTimer) return // already scheduled
  retryCount = Math.min(retryCount + (isShort ? 0 : 1), 6)
  const delay = isShort ? 3000 : Math.min(60000, Math.pow(2, retryCount) * 1000)
  console.log(chalk.gray(`ℹ️ Планируем рестарт WhatsApp через ${Math.round(delay/1000)}s (retryCount=${retryCount})`))
  retryTimer = setTimeout(()=> {
    retryTimer = null
    startWhatsApp({ reset: false })
  }, delay)
}

// ---------------- Groups and sending ----------------
async function cacheGroupId(sendWelcome=false) {
  try {
    if (!sock) return
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups || {})
    if (!list.length) return
    // find by name if provided
    let target = null
    if (WA_GROUP_ID && WA_GROUP_ID.includes('@g.us')) {
      target = list.find(g => g.id === WA_GROUP_ID)
    }
    if (!target && WA_GROUP_NAME) {
      target = list.find(g => (g.subject || '').trim().toLowerCase() === WA_GROUP_NAME.trim().toLowerCase())
    }
    // fallback: if only one group and WA_GROUP_ID/name not provided, pick first (not ideal)
    if (!target && list.length === 1) target = list[0]
    if (target) {
      cachedGroupJid = target.id
      console.log(chalk.green('✅ Найдена цель группа:'), target.subject, target.id)
      if (sendWelcome) {
        const welcome = `[🔧 сервисное сообщение]\n[🌎 подключено]\n[🚨 РАДАР АКТИВЕН 🚨]`
        try { await sendToWhatsApp(welcome) } catch(e){ console.log('⚠️ Не удалось отправить welcome:', e?.message || e) }
      }
    } else {
      console.log(chalk.yellow('⚠️ Целевая группа не найдена среди участвующих. Список:'))
      for (const g of list) console.log(' -', g.subject, g.id)
      cachedGroupJid = null
    }
  } catch (e) {
    console.error(chalk.red('❌ Ошибка cacheGroupId:'), e?.message || e)
  }
}

async function sendToWhatsApp(text) {
  try {
    if (!sock || waConnectionStatus !== 'connected') {
      console.log(chalk.yellow('⏳ WA не готов — сообщение пропущено:'), text?.toString?.().slice(0,120))
      return false
    }
    const jid = cachedGroupJid || WA_GROUP_ID
    if (!jid) {
      console.log(chalk.red('❌ Нет идентификатора группы для отправки (WA_GROUP_ID/WA_GROUP_NAME не настроены)'))
      return false
    }
    const to = jid.includes('@g.us') ? jid : (jid + '@g.us')
    await sock.sendMessage(to, { text: String(text) })
    console.log(chalk.green('➡️ Отправлено в WA:'), String(text).slice(0,120))
    return true
  } catch (e) {
    console.error(chalk.red('❌ Ошибка отправки в WA:'), e?.message || e)
    return false
  }
}

// ---------------- Web UI & HTTP API ----------------
const app = express()
app.use(express.json())

// root UI with buttons and live QR
app.get('/', (req,res) => {
  const qrPending = !!lastQR
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>TG→WA Bridge</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>body{font-family:sans-serif;background:#0b1220;color:#e6eef8;padding:20px} .card{max-width:980px;margin:0 auto;background:#07102a;padding:18px;border-radius:10px} a.btn{display:inline-block;margin:6px;padding:10px 14px;border-radius:8px;text-decoration:none;background:#06b6d4;color:#04202a;font-weight:700} .qr{margin-top:12px}</style>
  </head><body><div class="card"><h1>🤖 TG → WA Bridge</h1>
  <div><a class="btn" href="/ping" target="_blank">Ping</a><a class="btn" href="/healthz" target="_blank">Health</a><a class="btn" href="/tg/status" target="_blank">TG Status</a><a class="btn" href="/wa/status" target="_blank">WA Status</a><a class="btn" href="/wa/groups" target="_blank">WA Groups</a><a class="btn" href="/tg/send?text=Hello" target="_blank">Send → TG</a><a class="btn" href="/wa/send?text=Hello" target="_blank">Send → WA</a><a class="btn" href="/wa/reset" target="_blank">Reset WA</a><a class="btn" href="/wa/qr-ascii" target="_blank">QR ASCII</a></div>
  <div style="margin-top:12px">Domain: <strong>${UI_DOMAIN}</strong></div>
  <div style="margin-top:8px">WA: <strong>${waConnectionStatus}</strong> · TG: <strong>${tgClient? 'connected':'disconnected'}</strong></div>
  <div style="margin-top:10px" class="qr"><h3>QR Preview</h3><div id="qrbox">${ lastQR ? `<img src="/wa/qr-img?ts=${Date.now()}" style="max-width:320px"/>` : '<div style="color:#9fb0c8">QR not generated</div>' }</div><div style="font-size:13px;color:#97b2cc;margin-top:8px">QR auto refresh every 5s</div></div></div>
  <script>setInterval(()=>{fetch('/wa/status').then(r=>r.json()).then(j=>{ if(j.qrPending){ const img=document.querySelector('#qrbox img'); if(!img){document.getElementById('qrbox').innerHTML='<img src=\"/wa/qr-img?ts='+Date.now()+'\" style=\"max-width:320px\"/>'; } else img.src='/wa/qr-img?ts='+Date.now() } }).catch(()=>{}) },5000)</script></body></html>`
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.send(html)
})

app.get('/ping', (req,res) => res.send('pong'))
app.get('/healthz', (req,res) => res.status(200).send('ok'))

app.get('/tg/status', (req,res) => res.send({ telegram: !!tgClient, source: TG_SOURCE || null }))
app.post('/tg/send', async (req,res) => {
  const text = req.body.text || req.query.text
  if (!text) return res.status(400).send({ error: 'text required' })
  // send into TG source (only if bot)
  try {
    if (!tgClient) return res.status(500).send({ error: 'tg not connected' })
    await tgClient.sendMessage((TG_SOURCE||''), { message: String(text) })
    return res.send({ status:'ok', text })
  } catch (e) { console.error(e); return res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/status', (req,res) => res.send({
  whatsapp: waConnectionStatus,
  waGroup: cachedGroupJid || WA_GROUP_ID || null,
  qrPending: !!lastQR
}))

app.all('/wa/reset', async (req,res) => {
  try {
    // mark needAuthInProgress false to allow reset flow
    needAuthInProgress = false
    // clear local files & gist? we just reset local and request new auth
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch(e){}
    if (sock) {
      try { await sock.logout(); await sock.end() } catch(e){}
      sock = null
    }
    // start with reset to generate new QR
    setTimeout(()=> startWhatsApp({ reset: true }), 800)
    return res.send({ status:'ok', message: 'WA reset requested — new QR will be generated' })
  } catch (e) {
    console.error(e); return res.status(500).send({ error: e?.message || e })
  }
})

app.post('/wa/send', async (req,res) => {
  const text = req.body.text || req.query.text
  if (!text) return res.status(400).send({ error: 'text required' })
  try {
    const ok = await sendToWhatsApp(text)
    if (!ok) return res.status(500).send({ error: 'WA not ready or sending failed' })
    return res.send({ status: 'ok', text })
  } catch (e) { return res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/groups', async (req,res) => {
  try {
    if (!sock) return res.status(500).send({ error: 'whatsapp not connected' })
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups || {}).map(g => ({ id: g.id, name: g.subject }))
    return res.send(list)
  } catch (e) { console.error(e); return res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/qr-ascii', (req,res) => {
  if (!lastQR) return res.status(404).send('QR not available yet')
  // qrcode-terminal is small and sync; require dynamically to reduce bundle
  try {
    const qrcodeTerminal = await import('qrcode-terminal')
    const out = qrcodeTerminal.generate(lastQR, { small: true }, q => q)
    res.setHeader('Content-Type','text/plain; charset=utf-8')
    return res.send(out)
  } catch (e) {
    return res.status(500).send('Cannot render ascii QR: ' + (e?.message||e))
  }
})

app.get('/wa/qr', async (req,res) => {
  if (!lastQR) return res.status(404).send('QR not available yet')
  try {
    const dataUrl = await QRCode.toDataURL(lastQR, { margin: 1, width: 640 })
    res.setHeader('Content-Type','text/html; charset=utf-8')
    res.send(`<!doctype html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#071024"><img src="${dataUrl}" style="max-width:95%;max-height:95%"/></body></html>`)
  } catch (e) { res.status(500).send(e?.message||e) }
})

app.get('/wa/qr-img', async (req,res) => {
  if (!lastQR) return res.status(404).send('QR not available yet')
  try {
    const dataUrl = await QRCode.toDataURL(lastQR, { margin: 1, width: 512 })
    const base64 = dataUrl.split(',')[1]
    const buf = Buffer.from(base64, 'base64')
    res.setHeader('Content-Type','image/png')
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate')
    res.send(buf)
  } catch (e) { res.status(500).send(e?.message||e) }
})

// ---------------- Start services ----------------
;(async () => {
  // start TG and WA in parallel
  await startTelegram().catch(e=>console.error('tg start error',e))
  await startWhatsApp({ reset:false }).catch(e=>console.error('wa start error',e))

  app.listen(Number(PORT), () => {
    console.log(chalk.cyan(`🌐 HTTP доступен: ${UI_DOMAIN} (port ${PORT})`))
  })
})()

// ---------------- Graceful shutdown ----------------
process.on('SIGINT', async () => {
  console.log('👋 Shutdown...')
  try { if (sock) await sock.end(); if (tgClient) await tgClient.disconnect() } catch(e){}
  process.exit(0)
})
process.on('SIGTERM', async () => {
  console.log('👋 Shutdown...')
  try { if (sock) await sock.end(); if (tgClient) await tgClient.disconnect() } catch(e){}
  process.exit(0)
})
