// index.js
// Полный рабочий файл — Telegram → WhatsApp мост с хранением сессии в приватном Gist,
// живым WebUI (кнопки + QR preview), логированием в файл, дебаунсом сохранения и
// устойчивой логикой переподключения.
//
// Перед запуском убедитесь, что в .env заданы:
// TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION, TG_SOURCE,
// WA_GROUP_ID или WA_GROUP_NAME, GITHUB_TOKEN, GIST_ID, ADMIN_TOKEN (для /wa/relogin)
// и PORT (опционально).
//
// Этот файл рассчитан на запуск в контейнере (Render, Heroku и т.п.). Локальный
// компьютер не участвует — все файлы сессии временно записываются в каталог
// AUTH_DIR внутри контейнера, но основное хранилище — приватный Gist.

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
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import chalk from 'chalk'
import P from 'pino'
import { Boom } from '@hapi/boom'

// ---------------- config (from env) ----------------
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TG_SOURCE,
  WA_GROUP_ID,
  WA_GROUP_NAME,
  PORT = 3000,
  GITHUB_TOKEN,
  GIST_ID,
  AUTH_DIR = '/tmp/auth_info_baileys', // container-local temporary dir
  ADMIN_TOKEN = 'admin-token'
} = process.env

// ---------------- ensure dirs ----------------
try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
try { fs.mkdirSync('logs', { recursive: true }) } catch (e) {}
const LOG_FILE = path.join('logs', 'bridge.log')

// ---------------- simple file logger + console passthrough ----------------
function appendLogLine(s) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`) } catch (e) {}
}
function infoLog(s) { console.log(chalk.cyan(s)); appendLogLine(s) }
function warnLog(s) { console.log(chalk.yellow(s)); appendLogLine(s) }
function errorLog(s) { console.error(chalk.red(s)); appendLogLine(s) }

// ---------------- globals ----------------
let tgClient = null
let sock = null
let lastQR = null
let waConnectionStatus = 'disconnected' // connecting, awaiting_qr, connected
let isStartingWA = false
let saveAuthTimer = null
let retryTimer = null
let retryCount = 0
let cachedGroupJid = null

const PLOGGER = P({ level: 'warn' })
const UI_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`

// ---------------- Gist helpers ----------------
async function loadAuthFromGistToDir(dir) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    warnLog('GITHUB_TOKEN or GIST_ID not configured — skipping Gist load')
    return false
  }
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      timeout: 15000
    })
    const files = res.data.files
    if (!files || Object.keys(files).length === 0) {
      warnLog('Gist empty or no files')
      return false
    }
    fs.mkdirSync(dir, { recursive: true })
    for (const [filename, fileObj] of Object.entries(files)) {
      const fp = path.join(dir, filename)
      fs.writeFileSync(fp, fileObj.content || '', 'utf8')
    }
    infoLog('📥 Сессия загружена из Gist в ' + dir)
    return true
  } catch (err) {
    warnLog('⚠️ Ошибка загрузки из Gist: ' + (err?.message || err))
    return false
  }
}

function debounceSaveAuthToGist(dir) {
  if (saveAuthTimer) clearTimeout(saveAuthTimer)
  saveAuthTimer = setTimeout(() => { saveAuthToGist(dir).catch(()=>{}) }, 2500)
}

async function saveAuthToGist(dir) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    warnLog('GITHUB_TOKEN or GIST_ID not configured — skipping Gist save')
    return
  }
  try {
    if (!fs.existsSync(dir)) { warnLog('AUTH dir missing — nothing to save'); return }
    const files = {}
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f)
      if (!fs.statSync(fp).isFile()) continue
      files[f] = { content: fs.readFileSync(fp, 'utf8') }
    }
    if (Object.keys(files).length === 0) { warnLog('No auth files to save'); return }
    await axios.patch(`https://api.github.com/gists/${GIST_ID}`, { files }, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      timeout: 15000
    })
    infoLog('✅ Auth сохранён в Gist')
  } catch (err) {
    warnLog('⚠️ Ошибка при сохранении auth в Gist: ' + (err?.message || err))
  }
}

// ---------------- Telegram ----------------
async function startTelegram() {
  try {
    infoLog('🚀 Подключение к Telegram...')
    tgClient = new TelegramClient(new StringSession(TELEGRAM_STRING_SESSION || ''), Number(TELEGRAM_API_ID), TELEGRAM_API_HASH, { connectionRetries: 5 })
    await tgClient.connect()
    infoLog('✅ Telegram подключён')
    tgClient.addEventHandler(onTelegramMessage, new NewMessage({}))
  } catch (e) {
    errorLog('❌ Ошибка Telegram: ' + (e?.message || e))
    tgClient = null
  }
}

async function sendTelegramNotification(text) {
  try {
    if (!tgClient || !TG_SOURCE) return
    await tgClient.sendMessage(TG_SOURCE, { message: String(text) })
  } catch (e) {
    warnLog('⚠️ Не удалось отправить уведомление в Telegram: ' + (e?.message || e))
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

    let text = null
    if (message.message && typeof message.message === 'string') text = message.message
    else if (message.message?.message?.conversation) text = message.message.message.conversation
    else if (message.message?.message?.text) text = message.message.message.text

    if (isFromSource && text && String(text).trim()) {
      infoLog('✉️ Получено из TG: ' + String(text).slice(0,200))
      await sendToWhatsApp(String(text))
    }
  } catch (e) {
    errorLog('⚠️ Ошибка обработки TG event: ' + (e?.message || e))
  }
}

// ---------------- WhatsApp ----------------
function scheduleRestart(short = false) {
  if (retryTimer) return
  retryCount = Math.min(retryCount + 1, 8)
  const delay = short ? 3000 : Math.min(120000, Math.pow(2, retryCount) * 1000)
  infoLog(`ℹ️ Планируем рестарт WA через ${Math.round(delay/1000)}s (retryCount=${retryCount})`)
  retryTimer = setTimeout(() => { retryTimer = null; startWhatsApp({ reset: false }) }, delay)
}

async function startWhatsApp({ reset = false } = {}) {
  if (isStartingWA) { infoLog('ℹ️ startWhatsApp уже выполняется'); return }
  isStartingWA = true
  waConnectionStatus = 'connecting'
  infoLog(`🚀 Запуск WhatsApp... reset=${reset}`)

  try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}

  if (reset) {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
    lastQR = null
  }

  // Load auth from gist (if exists) into AUTH_DIR. If not present — fresh QR flow.
  const loaded = await loadAuthFromGistToDir(AUTH_DIR).catch(()=>false)
  if (!loaded) warnLog('⚠️ Сессия из Gist не найдена — ожидается авторизация через QR')

  // init baileys auth state (will create files if absent)
  let state, saveCreds
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR))
  } catch (e) {
    errorLog('❌ useMultiFileAuthState failed: ' + (e?.message || e))
    isStartingWA = false
    scheduleRestart(false)
    return
  }

  // latest baileys version
  let version = undefined
  try { version = (await fetchLatestBaileysVersion()).version } catch (e) {}

  // create socket
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
    errorLog('❌ makeWASocket failed: ' + (e?.message || e))
    isStartingWA = false
    scheduleRestart(false)
    return
  }

  // when credentials change — save locally (useMultiFileAuthState already writes) and debounce save to gist
  sock.ev.on('creds.update', async () => {
    try { await saveCreds() } catch (e) {}
    debounceSaveAuthToGist(AUTH_DIR)
  })

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        lastQR = qr
        waConnectionStatus = 'awaiting_qr'
        infoLog('📱 Сгенерирован новый QR (доступен на /wa/qr и WebUI)')
        // console ASCII
        try { qrcodeTerminal.generate(qr, { small: true }) } catch(e){}
        await sendTelegramNotification('⚠️ Новый QR для WhatsApp')
      }

      if (connection === 'open') {
        waConnectionStatus = 'connected'
        retryCount = 0
        infoLog('✅ WhatsApp подключён')
        // save auth ASAP (debounced)
        debounceSaveAuthToGist(AUTH_DIR)
        // cache groups
        try { await cacheGroupId(true) } catch (e) { warnLog('⚠️ cacheGroupId failed: ' + (e?.message||e)) }
        isStartingWA = false
        lastQR = null
      }

      if (connection === 'close') {
        waConnectionStatus = 'disconnected'
        isStartingWA = false
        let code = null
        try { code = new Boom(lastDisconnect?.error)?.output?.statusCode } catch (e) { code = lastDisconnect?.error?.output?.statusCode || null }
        warnLog('⚠️ WhatsApp соединение закрыто ' + (code || ''))
        // clean sock
        try { await sock?.end?.() } catch (e) {}
        // logic:
        // 401/428 -> session invalid -> restart with reset (new QR)
        // 409 (conflict) -> do not immediately restart (could be duplicated connection). schedule retry longer.
        // 440 -> also schedule retry
        if ([401, 428].includes(code)) {
          infoLog('❌ Сессия недействительна — стартуем flow с новой авторизацией (QR)')
          scheduleRestart(true) // short delay then reset
          // force reset on next start
          setTimeout(()=> startWhatsApp({ reset: true }), 2000)
        } else if ([409].includes(code)) {
          warnLog('⚠️ Conflict — не перезапускаем агрессивно. Попробуем позже.')
          scheduleRestart(true)
        } else {
          scheduleRestart(false)
        }
      }
    } catch (e) {
      errorLog('⚠️ Ошибка connection.update: ' + (e?.message || e))
      isStartingWA = false
      scheduleRestart(false)
    }
  })

  sock.ev.on('messages.upsert', m => {
    try {
      const text = m?.messages?.[0]?.message?.conversation || m?.messages?.[0]?.message?.extendedText?.text
      if (text) infoLog('📥 WA message preview: ' + String(text).slice(0, 120))
    } catch (e) {}
  })

  sock.ev.on('connection.error', (err) => { warnLog('⚠️ connection.error: ' + (err?.message || err)) })
}

// ---------------- groups + send ----------------
async function cacheGroupId(sendWelcome=false) {
  try {
    if (!sock) return
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups || {})
    if (!list.length) { warnLog('⚠️ Учетных групп нет'); cachedGroupJid = null; return }
    // match by explicit ID or name
    let target = null
    if (WA_GROUP_ID) {
      const normalized = WA_GROUP_ID.endsWith('@g.us') ? WA_GROUP_ID : (WA_GROUP_ID + '@g.us')
      target = list.find(g => g.id === normalized)
    }
    if (!target && WA_GROUP_NAME) target = list.find(g => (g.subject||'').trim().toLowerCase() === WA_GROUP_NAME.trim().toLowerCase())
    if (!target && list.length === 1) target = list[0]
    if (target) {
      cachedGroupJid = target.id
      infoLog('✅ Найдена WA группа: ' + (target.subject || '') + ' (' + target.id + ')')
      if (sendWelcome) {
        try { await sendToWhatsApp('[🔧 сервисное сообщение]\n[🌎 подключено]') } catch(e){ warnLog('⚠️ Не удалось отправить welcome: ' + (e?.message||e)) }
      }
    } else {
      cachedGroupJid = null
      warnLog('⚠️ Целевая группа не найдена среди: ' + list.map(g => g.subject + '|' + g.id).join(', '))
    }
  } catch (e) {
    errorLog('❌ Ошибка cacheGroupId: ' + (e?.message || e))
  }
}

async function sendToWhatsApp(text) {
  try {
    if (!sock || waConnectionStatus !== 'connected') { warnLog('⏳ WA не готов — сообщение не отправлено'); return false }
    const jid = cachedGroupJid || (WA_GROUP_ID ? (WA_GROUP_ID.endsWith('@g.us') ? WA_GROUP_ID : WA_GROUP_ID + '@g.us') : null)
    if (!jid) { errorLog('❌ Нет идентификатора группы для отправки'); return false }
    await sock.sendMessage(jid, { text: String(text) })
    infoLog('➡️ Отправлено в WA: ' + String(text).slice(0, 200))
    return true
  } catch (e) {
    errorLog('❌ Ошибка отправки в WA: ' + (e?.message || e))
    return false
  }
}

// ---------------- HTTP endpoints + WebUI ----------------
const app = express()
app.use(express.json())

app.get('/ping', (req, res) => res.send('pong'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))

app.get('/tg/status', (req, res) => {
  res.send({ telegram: !!tgClient, source: TG_SOURCE || null })
})

app.post('/tg/send', async (req, res) => {
  const text = req.body.text || req.query.text
  if (!text) return res.status(400).send({ error: 'text required' })
  if (!tgClient) return res.status(500).send({ error: 'telegram not connected' })
  try {
    await tgClient.sendMessage(TG_SOURCE, { message: String(text) })
    res.send({ status: 'ok', text })
  } catch (e) {
    res.status(500).send({ error: e?.message || e })
  }
})

// WA status + UI needs
app.get('/wa/status', (req, res) => {
  res.send({
    whatsapp: waConnectionStatus,
    qrPending: !!lastQR,
    waGroup: cachedGroupJid ? { id: cachedGroupJid } : null
  })
})

app.post('/wa/reset', async (req, res) => {
  // reset session (wipe local temp, wipe gist entry if desired)
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    if (sock) try { await sock.logout(); await sock.end() } catch (e) {}
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch (e) {}
    lastQR = null
    cachedGroupJid = null
    setTimeout(() => startWhatsApp({ reset: true }), 800)
    res.send({ status: 'ok', message: 'reset started' })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.post('/wa/relogin', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    // trigger re-login (wipe local files and restart flow)
    if (sock) try { await sock.logout(); await sock.end() } catch (e) {}
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
    lastQR = null
    cachedGroupJid = null
    setTimeout(() => startWhatsApp({ reset: true }), 500)
    res.send({ status: 'ok', message: 'relogin started' })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

// UI trigger (GET) — calls POST with admin token
app.get('/wa/relogin-ui', (req, res) => {
  const token = ADMIN_TOKEN
  fetch(`${UI_DOMAIN}/wa/relogin?token=${token}`, { method: 'POST' }).catch(()=>{})
  res.send(`<html><body><p>Relogin requested. Вернитесь на <a href="/">главную</a>.</p></body></html>`)
})

app.get('/wa/qr', async (req, res) => {
  if (!lastQR) return res.status(404).send('QR не сгенерирован')
  try {
    const dataUrl = await QRCode.toDataURL(lastQR, { margin: 1, width: 640 })
    const html = `<!doctype html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#071024"><img src="${dataUrl}" /></body></html>`
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (e) {
    res.status(500).send(e?.message || e)
  }
})

app.get('/wa/qr-img', async (req, res) => {
  if (!lastQR) return res.status(404).send('QR not generated')
  try {
    const buffer = await QRCode.toBuffer(lastQR, { type: 'png', scale: 8 })
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.send(buffer)
  } catch (e) {
    errorLog('QR generation error: ' + (e?.message || e))
    res.status(500).send('QR generation failed')
  }
})

app.get('/wa/qr-ascii', (req, res) => {
  if (!lastQR) return res.status(404).send('QR not generated')
  qrcodeTerminal.generate(lastQR, { small: true }, qrcode => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(qrcode)
  })
})

app.post('/wa/send', async (req, res) => {
  const text = req.body.text || req.query.text
  if (!text) return res.status(400).send({ error: 'text required' })
  try {
    const ok = await sendToWhatsApp(String(text))
    if (!ok) return res.status(500).send({ error: 'send failed' })
    res.send({ status: 'ok', text })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/groups', async (req, res) => {
  if (!sock || waConnectionStatus !== 'connected') return res.status(500).send({ error: 'whatsapp not connected' })
  try {
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups || {}).map(g => ({ id: g.id, name: g.subject }))
    res.send(list)
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

// Root WebUI with live QR preview + buttons
app.get('/', (req, res) => {
  const qrPending = !!lastQR
  const html = `<!doctype html><html><head><meta charset="utf-8" /><title>TG→WA Bridge</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family:Inter,Segoe UI,Roboto,Arial;background:#0f1724;color:#e6eef8;margin:0;padding:24px;display:flex;justify-content:center}
    .card{max-width:980px;width:100%;background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));border-radius:12px;padding:18px}
    .btn{display:inline-block;margin:6px;padding:10px 14px;border-radius:10px;text-decoration:none;background:#06b6d4;color:#04202a;font-weight:700}
    .ghost{background:transparent;border:1px solid rgba(255,255,255,0.06);color:#dcecff;padding:10px 14px;border-radius:10px;text-decoration:none}
    .qr{margin-top:12px}
  </style>
  </head><body><div class="card">
  <h1>🤖 TG → WA Bridge</h1>
  <div>
    <a class="btn" href="/ping" target="_blank">Ping</a>
    <a class="btn" href="/healthz" target="_blank">Health</a>
    <a class="btn" href="/tg/status" target="_blank">TG Status</a>
    <a class="btn" href="/wa/status" target="_blank">WA Status</a>
    <a class="btn" href="/wa/groups" target="_blank">WA Groups</a>
    <a class="btn" href="/wa/send?text=Hello%20from%20bridge" target="_blank">Send → WA</a>
    <a class="btn" href="/wa/reset?token=${ADMIN_TOKEN}" target="_blank">Reset WA</a>
    <a class="btn" href="/wa/relogin-ui" target="_blank">Relogin WA</a>
    <a class="ghost" href="/wa/qr-ascii" target="_blank">QR ASCII</a>
  </div>
  <div style="margin-top:12px">WA: <strong>${waConnectionStatus}</strong> · Telegram: <strong>${tgClient ? 'connected' : 'disconnected'}</strong></div>
  <div class="qr" id="qrbox">${ lastQR ? `<img src="/wa/qr-img?ts=${Date.now()}" style="max-width:320px;"/>` : `<div style="color:#9fb0c8">QR not generated</div>` }</div>
  <p style="margin-top:10px;color:#9fb0c8">QR автоматически обновляется (каждые 3s) — если появляется новый QR, отсканируйте его в WhatsApp</p>
  <script>
    setInterval(async ()=> {
      try {
        const res = await fetch('/wa/status')
        if(!res.ok) return
        const j = await res.json()
        const pending = j.qrPending
        const box = document.getElementById('qrbox')
        if(pending){
          let img = box.querySelector('img')
          if(!img){
            img = document.createElement('img'); img.style.maxWidth='320px'
            box.innerHTML=''; box.appendChild(img)
          }
          img.src = '/wa/qr-img?ts=' + Date.now()
        } else {
          // no-op (keep last)
        }
      } catch(e){}
    }, 3000)
  </script>
  </div></body></html>`
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})

// ---------------- start ----------------
;(async () => {
  try {
    await startTelegram()
    await startWhatsApp({ reset: false })
    app.listen(Number(PORT), () => {
      infoLog(`🌐 HTTP доступен: ${UI_DOMAIN} (port ${PORT})`)
      appendLogLine('Available endpoints: /, /ping, /healthz, /tg/status, /tg/send, /wa/status, /wa/groups, /wa/send, /wa/qr, /wa/qr-img, /wa/qr-ascii, /wa/reset, /wa/relogin')
    })
  } catch (e) {
    errorLog('❌ Ошибка старта сервиса: ' + (e?.message || e))
    process.exit(1)
  }
})()

// ---------------- graceful shutdown ----------------
process.on('SIGINT', async () => {
  infoLog('👋 Завершение...')
  try { await sock?.end?.(); await tgClient?.disconnect?.() } catch (e) {}
  process.exit(0)
})
process.on('SIGTERM', async () => {
  infoLog('👋 Завершение...')
  try { await sock?.end?.(); await tgClient?.disconnect?.() } catch (e) {}
  process.exit(0)
})
