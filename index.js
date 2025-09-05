// index.js (полностью обновлённый)
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
import util from 'util'

// ----------------- NOISY LOGS FILTER -----------------
const SUPPRESS_PATTERNS = [
  'Closing stale open session',
  'Closing session: SessionEntry',
  'SessionEntry',
  'ephemeralKeyPair',
  'privKey: <Buffer',
  'pubKey: <Buffer',
  'currentRatchet',
  'lastRemoteEphemeralKey',
  'rootKey',
  'preKeyId:',
  'chainKey: [Object]',
  'messageKeys: {}'
]
function shouldSuppressLogLine(s) {
  if (!s) return false
  try {
    for (const p of SUPPRESS_PATTERNS) {
      if (s.indexOf(p) !== -1) return true
    }
  } catch (e) {}
  return false
}
const _origLog = console.log.bind(console)
const _origInfo = console.info.bind(console)
const _origWarn = console.warn.bind(console)
const _origError = console.error.bind(console)
;['log','info','warn','error'].forEach(level => {
  const orig = { log: _origLog, info: _origInfo, warn: _origWarn, error: _origError }[level]
  console[level] = (...args) => {
    try {
      const s = util.format(...args)
      if (shouldSuppressLogLine(s)) return
      orig(s)
    } catch (e) {
      orig(...args)
    }
  }
})
// ----------------- end filter -----------------

// ---- env/config ----
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TELEGRAM_SOURCE,            // <-- единое имя переменной
  WA_GROUP_ID,
  WA_GROUP_NAME,
  WHATSAPP_GROUP_ID,
  WHATSAPP_GROUP_NAME,
  PORT = 3000,
  GITHUB_TOKEN,
  GIST_ID,
  AUTH_DIR = '/tmp/auth_info_baileys',
  ADMIN_TOKEN = 'admin-token',
  LOG_LEVEL
} = process.env

const CONFIG_GROUP_ID = (WA_GROUP_ID && WA_GROUP_ID.trim()) ? WA_GROUP_ID.trim()
  : (WHATSAPP_GROUP_ID && WHATSAPP_GROUP_ID.trim() ? WHATSAPP_GROUP_ID.trim() : null)
const CONFIG_GROUP_NAME = (WA_GROUP_NAME && WA_GROUP_NAME.trim()) ? WA_GROUP_NAME.trim()
  : (WHATSAPP_GROUP_NAME && WHATSAPP_GROUP_NAME.trim() ? WHATSAPP_GROUP_NAME.trim() : null)

// ---- ensure temp dirs ----
try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
try { fs.mkdirSync('logs', { recursive: true }) } catch (e) {}
const LOG_FILE = path.join('logs', 'bridge.log')
const LOCK_FILE = path.join(AUTH_DIR, '.singleton.lock')

// ---- singleton lock: предотвращаем одновременный запуск ----
try {
  const fd = fs.openSync(LOCK_FILE, 'wx')
  fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
  fs.closeSync(fd)
  const cleanupLock = () => { try { fs.rmSync(LOCK_FILE) } catch(e){} }
  process.on('exit', cleanupLock)
  process.on('SIGINT', cleanupLock)
  process.on('SIGTERM', cleanupLock)
} catch (e) {
  console.error(chalk.red('❌ Another instance appears to be running (lockfile exists). Exiting to avoid session conflicts.'))
  console.error(chalk.red(`Lockfile: ${LOCK_FILE}`))
  process.exit(1)
}

// ---- logging helpers ----
function appendLogLine(s) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`) } catch (e) {}
}
function infoLog(s) { console.log(chalk.cyan(s)); appendLogLine(s) }
function warnLog(s) { console.log(chalk.yellow(s)); appendLogLine(s) }
function errorLog(s) { console.error(chalk.red(s)); appendLogLine(s) }

// ---- globals ----
let tgClient = null
let sock = null
let lastQR = null
let waConnectionStatus = 'disconnected' // connecting, awaiting_qr, connected, conflict
let isStartingWA = false
let saveAuthTimer = null
let restartTimer = null
let restartCount = 0
let cachedGroupJid = null
let lastConflictAt = 0
let conflictCount = 0

const PLOGGER = P({ level: LOG_LEVEL || 'error' })
const UI_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`

// --- in-memory short caches for monitoring
const MAX_CACHE = 200
const recentForwarded = []     // {text, ts}
const recentWAMessages = []    // {from, text, ts}

// ---- Gist helpers ----
async function loadAuthFromGistToDir(dir) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    warnLog('GITHUB_TOKEN/GIST_ID not set — skipping Gist load')
    return false
  }
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      timeout: 15000
    })
    const files = res.data.files
    if (!files || Object.keys(files).length === 0) {
      warnLog('Gist empty or missing files')
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
    warnLog('⚠️ Ошибка загрузки auth из Gist: ' + (err?.message || err))
    return false
  }
}
function debounceSaveAuthToGist(dir) {
  if (saveAuthTimer) clearTimeout(saveAuthTimer)
  saveAuthTimer = setTimeout(() => { saveAuthToGist(dir).catch(()=>{}) }, 2500)
}
async function saveAuthToGist(dir) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    warnLog('GITHUB_TOKEN/GIST_ID not set — skipping Gist save')
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

// ---- Telegram ----
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
    if (!tgClient || !TELEGRAM_SOURCE) return
    await tgClient.sendMessage(TELEGRAM_SOURCE, { message: String(text) })
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
    const source = (TELEGRAM_SOURCE || '').toString().replace(/^@/,'').toLowerCase()
    const isFromSource = source && (senderUsername === source || senderIdStr === source || ('-' + senderIdStr) === source)

    let text = null
    if (message.message && typeof message.message === 'string') text = message.message
    else if (message.message?.message?.conversation) text = message.message.message.conversation
    else if (message.message?.message?.text) text = message.message.message.text

    if (isFromSource && text && String(text).trim()) {
      infoLog('✉️ Получено из TG: ' + String(text).slice(0,200))
      await sendToWhatsApp(String(text))
    } else {
      // логируем непризнанные сообщения для отладки
      if (text && String(text).trim()) {
        infoLog(`ℹ️ TG message ignored (not from source). from='${senderUsername||senderIdStr}' srcExpected='${source}' preview='${String(text).slice(0,80)}'`)
      }
    }
  } catch (e) {
    errorLog('⚠️ Ошибка обработки TG event: ' + (e?.message || e))
  }
}

// ---- WhatsApp ----
function scheduleRestart({ reset = false } = {}) {
  if (restartTimer) return
  restartCount = Math.min(restartCount + 1, 8)
  const delay = Math.min(60000, Math.pow(2, restartCount) * 1000)
  infoLog(`ℹ️ Планируем рестарт WA через ${Math.round(delay/1000)}s (reset=${reset}, retryCount=${restartCount})`)
  restartTimer = setTimeout(() => {
    restartTimer = null
    startWhatsApp({ reset }).catch(e => {
      warnLog('⚠️ Ошибка при автоматическом рестарте WA: ' + (e?.message || e))
    })
  }, delay)
}

async function startWhatsApp({ reset = false } = {}) {
  if (isStartingWA) {
    infoLog('ℹ️ startWhatsApp уже выполняется — возвращаемся')
    return
  }
  isStartingWA = true
  waConnectionStatus = 'connecting'
  infoLog(`🚀 Запуск WhatsApp... reset=${reset}`)
  infoLog(`🔎 Ищем группу по CONFIG_GROUP_ID='${CONFIG_GROUP_ID || ''}' CONFIG_GROUP_NAME='${CONFIG_GROUP_NAME || ''}'`)

  try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}

  if (!reset) {
    await loadAuthFromGistToDir(AUTH_DIR).catch(()=>{})
  } else {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
    lastQR = null
    infoLog('ℹ️ Подготовлено пустое AUTH_DIR для новой авторизации')
  }

  let state, saveCreds
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR))
  } catch (e) {
    errorLog('❌ useMultiFileAuthState failed: ' + (e?.message || e))
    isStartingWA = false
    scheduleRestart({ reset: false })
    return
  }

  let version = undefined
  try { version = (await fetchLatestBaileysVersion()).version } catch (e) {}

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
    scheduleRestart({ reset: false })
    return
  }

  sock.ev.on('creds.update', async () => {
    try { await saveCreds() } catch (e) {}
    debounceSaveAuthToGist(AUTH_DIR)
  })

  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        lastQR = qr
        waConnectionStatus = 'awaiting_qr'
        infoLog('📱 QR сгенерирован (доступен на /wa/qr и /wa/qr-img)')
        try { qrcodeTerminal.generate(qr, { small: true }) } catch(e){}
        await sendTelegramNotification('⚠️ Новый QR для WhatsApp')
      }

      if (connection === 'open') {
        waConnectionStatus = 'connected'
        restartCount = 0
        conflictCount = 0
        infoLog('✅ WhatsApp подключён')
        try { await saveCreds() } catch (e) {}
        debounceSaveAuthToGist(AUTH_DIR)
        try { await cacheGroupId(true) } catch (e) { warnLog('⚠️ cacheGroupId failed: ' + (e?.message || e)) }
        lastQR = null
        isStartingWA = false
      }

      if (connection === 'close') {
        waConnectionStatus = 'disconnected'
        isStartingWA = false
        let code = null
        try { code = new Boom(lastDisconnect?.error)?.output?.statusCode } catch (e) { code = lastDisconnect?.error?.output?.statusCode || null }
        warnLog('⚠️ WhatsApp соединение закрыто ' + (code || 'unknown'))
        try { await sock?.end?.() } catch (e) {}

        if (code === 440) {
          lastConflictAt = Date.now()
          conflictCount = (conflictCount || 0) + 1
          warnLog('⚠️ Stream conflict (440). conflictCount=' + conflictCount)
          waConnectionStatus = 'conflict'
          await sendTelegramNotification(`⚠️ WhatsApp session conflict detected (440). conflictCount=${conflictCount}. Требуется relogin.`).catch(()=>{})
          return
        } else if ([401, 428].includes(code)) {
          warnLog('❌ Сессия недействительна — запустим flow с новой авторизацией (QR)')
          scheduleRestart({ reset: true })
        } else if (code === 409) {
          warnLog('⚠️ Conflict (409) — ожидание, не форсируем рестарт')
          scheduleRestart({ reset: false })
        } else {
          scheduleRestart({ reset: false })
        }
      }
    } catch (e) {
      errorLog('⚠️ Ошибка connection.update handler: ' + (e?.message || e))
      isStartingWA = false
      scheduleRestart({ reset: false })
    }
  })

  sock.ev.on('messages.upsert', m => {
    try {
      const raw = m?.messages?.[0]
      const text = raw?.message?.conversation || raw?.message?.extendedText?.text
      const from = raw?.key?.remoteJid
      if (text) {
        infoLog('📥 WA message preview: ' + String(text).slice(0, 120))
        recentWAMessages.push({ from: from || null, text: String(text), ts: Date.now() })
        if (recentWAMessages.length > MAX_CACHE) recentWAMessages.shift()
      }
    } catch (e) {}
  })

  sock.ev.on('connection.error', (err) => { warnLog('⚠️ connection.error: ' + (err?.message || err)) })
}

// ---- cacheGroupId ----
function normalizeName(s) {
  if (!s) return ''
  return String(s).replace(/^[\s"'`]+|[\s"'`]+$/g, '').trim().toLowerCase()
}
function stripNonAlnum(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi,'').trim()
}

async function cacheGroupId(sendWelcome=false) {
  try {
    if (!sock || waConnectionStatus !== 'connected') { warnLog('WA not connected for group caching'); return }
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups || {})
    infoLog(`🔎 Найдено ${list.length} групп(ы)`)

    const candidates = list.map(g => {
      return { id: g.id, name: g.subject || '' }
    })
    infoLog('📋 Доступные группы: ' + candidates.map(c => `${c.name}|${c.id}`).join(', '))

    const cfgIdRaw = CONFIG_GROUP_ID || null
    const cfgId = cfgIdRaw ? (String(cfgIdRaw).endsWith('@g.us') ? cfgIdRaw : String(cfgIdRaw) + '@g.us') : null
    const cfgNameRaw = CONFIG_GROUP_NAME || null
    const cfgName = normalizeName(cfgNameRaw)
    infoLog(`🔍 Ищу target by id=${cfgId} name="${cfgNameRaw}" (normalized="${cfgName}")`)

    let target = null
    if (cfgId) {
      target = list.find(g => g.id === cfgId)
      if (target) {
        infoLog('✅ Найдено по JID: ' + cfgId)
      }
    }

    if (!target && cfgName) {
      target = list.find(g => normalizeName(g.subject) === cfgName)
      if (target) infoLog(`✅ Найдено по точному имени: "${target.subject}"`)
    }

    if (!target && cfgName) {
      target = list.find(g => normalizeName((g.subject||'')).startsWith(cfgName))
      if (target) infoLog(`✅ Найдено по startsWith: "${target.subject}"`)
    }

    if (!target && cfgName) {
      target = list.find(g => normalizeName((g.subject||'')).includes(cfgName))
      if (target) infoLog(`✅ Найдено по contains: "${target.subject}"`)
    }

    if (!target && cfgName) {
      const wanted = stripNonAlnum(cfgName)
      target = list.find(g => stripNonAlnum(g.subject) === wanted)
      if (target) infoLog(`✅ Найдено по stripNonAlnum exact: "${target.subject}"`)
    }

    if (!target && list.length === 1) {
      target = list[0]
      infoLog('ℹ️ Выбрана единственная доступная группа: ' + (target.subject||'') + ' ('+target.id+')')
    }

    if (target) {
      cachedGroupJid = target.id
      infoLog('✅ Закэширован target group: ' + (target.subject || '') + ' (' + target.id + ')')
      if (sendWelcome) {
        try { await sendToWhatsApp('[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]') } catch(e){ warnLog('⚠️ Не удалось отправить welcome: ' + (e?.message||e)) }
      }
    } else {
      cachedGroupJid = null
      warnLog('⚠️ Целевая группа не найдена; доступные: ' + candidates.map(g => `${g.name}|${g.id}`).join(', '))
    }
  } catch (e) {
    errorLog('❌ Ошибка cacheGroupId: ' + (e?.message || e))
  }
}

// ---- send ----
async function sendToWhatsApp(text) {
  try {
    if (!sock || waConnectionStatus !== 'connected') { warnLog('⏳ WA не готов — сообщение не отправлено'); return false }
    const jid = cachedGroupJid || (CONFIG_GROUP_ID ? (CONFIG_GROUP_ID.endsWith('@g.us') ? CONFIG_GROUP_ID : CONFIG_GROUP_ID + '@g.us') : null)
    if (!jid) { errorLog('❌ Нет идентификатора группы для отправки'); return false }
    await sock.sendMessage(jid, { text: String(text) })
    infoLog('➡️ Отправлено в WA: ' + String(text).slice(0, 200))
    recentForwarded.push({ text: String(text), ts: Date.now() })
    if (recentForwarded.length > MAX_CACHE) recentForwarded.shift()
    return true
  } catch (e) {
    errorLog('❌ Ошибка отправки в WA: ' + (e?.message || e))
    return false
  }
}

// ---- HTTP + UI ----
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/ping', (req, res) => res.send('pong'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))

app.get('/tg/status', (req, res) => res.send({ telegram: !!tgClient, source: TELEGRAM_SOURCE || null }))

app.post('/tg/send', async (req, res) => {
  const text = req.body.text || req.query.text
  if (!text) return res.status(400).send({ error: 'text required' })
  if (!tgClient) return res.status(500).send({ error: 'telegram not connected' })
  try {
    await tgClient.sendMessage(TELEGRAM_SOURCE, { message: String(text) })
    res.send({ status: 'ok', text })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/status', (req, res) => {
  res.send({
    whatsapp: waConnectionStatus,
    qrPending: !!lastQR,
    waGroup: cachedGroupJid ? { id: cachedGroupJid } : null,
    configuredGroupId: CONFIG_GROUP_ID || null,
    configuredGroupName: CONFIG_GROUP_NAME || null
  })
})

app.get('/wa/auth-status', (req, res) => {
  try {
    if (!fs.existsSync(AUTH_DIR)) return res.send({ exists: false, files: [] })
    const files = fs.readdirSync(AUTH_DIR).filter(f => fs.statSync(path.join(AUTH_DIR, f)).isFile())
    res.send({ exists: true, files })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.post('/wa/reset', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    if (sock) try { await sock.logout(); await sock.end() } catch (e) {}
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
    lastQR = null; cachedGroupJid = null
    scheduleRestart({ reset: true })
    res.send({ status: 'ok', message: 'reset scheduled' })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.post('/wa/relogin', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    if (sock) try { await sock.logout(); await sock.end() } catch (e) {}
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
    lastQR = null; cachedGroupJid = null
    scheduleRestart({ reset: true })
    res.send({ status: 'ok', message: 'relogin scheduled' })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/relogin-ui', (req, res) => {
  const token = ADMIN_TOKEN
  axios.post(`${UI_DOMAIN}/wa/relogin?token=${token}`).catch(()=>{})
  res.send(`<html><body><p>Relogin requested. Return to <a href="/">main</a>.</p></body></html>`)
})

app.get('/wa/qr', async (req, res) => {
  if (!lastQR) return res.status(404).send('QR not generated')
  try {
    const dataUrl = await QRCode.toDataURL(lastQR, { margin: 1, width: 640 })
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(`<!doctype html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#071024"><img src="${dataUrl}" /></body></html>`)
  } catch (e) { res.status(500).send(e?.message || e) }
})

app.get('/wa/qr-img', async (req, res) => {
  if (!lastQR) return res.status(404).send('QR not generated')
  try {
    const buf = await QRCode.toBuffer(lastQR, { type: 'png', scale: 8 })
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store, no-cache')
    res.send(buf)
  } catch (e) { res.status(500).send(e?.message || e) }
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

// recent forwarded messages (for monitoring)
app.get('/wa/recent-forwarded', (req, res) => {
  res.send(recentForwarded.slice().reverse())
})
// recent inbound WA messages
app.get('/wa/recent-messages', (req, res) => {
  res.send(recentWAMessages.slice().reverse())
})

app.get('/logs', (req, res) => {
  try {
    const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(content)
  } catch (e) { res.status(500).send(e?.message || e) }
})

// tail logs: /logs/tail?lines=100
app.get('/logs/tail', (req, res) => {
  try {
    const lines = parseInt(req.query.lines || '200', 10)
    const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''
    const arr = content.trim().split('\n').filter(Boolean)
    const tail = arr.slice(-lines).join('\n')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(tail)
  } catch (e) { res.status(500).send(e?.message || e) }
})

// main UI — кнопки не открывают новые вкладки, есть мини-чат/форма
app.get('/', (req, res) => {
  const qrPending = !!lastQR
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>TG→WA Bridge</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root{--bg:#0f1724;--card:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));--accent:#06b6d4;--muted:#9fb0c8}
    body{font-family:Inter,Segoe UI,Roboto,Arial;background:var(--bg);color:#e6eef8;margin:0;padding:18px;display:flex;justify-content:center}
    .card{max-width:980px;width:100%;background:var(--card);border-radius:12px;padding:18px;box-sizing:border-box}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .btn{display:inline-flex;align-items:center;justify-content:center;margin:6px;padding:10px 14px;border-radius:10px;text-decoration:none;background:var(--accent);color:#04202a;font-weight:700;cursor:pointer;border:none}
    .ghost{background:transparent;border:1px solid rgba(255,255,255,0.06);color:#dcecff;padding:10px 14px;border-radius:10px;text-decoration:none;cursor:pointer}
    .qr{margin-top:12px}
    .statusline{margin-top:12px;color:var(--muted)}
    .panel{display:grid;grid-template-columns:1fr 360px;gap:12px;margin-top:12px}
    .panel .col{background:rgba(0,0,0,0.12);padding:12px;border-radius:8px;min-height:120px}
    textarea{width:100%;height:90px;border-radius:8px;padding:8px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit;resize:vertical}
    input[type=text]{width:100%;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit}
    .small{font-size:13px;color:var(--muted)}
    .list{max-height:220px;overflow:auto;padding:6px}
    .log{white-space:pre-wrap;font-family:monospace;font-size:12px;color:#cfeefb}
    @media(max-width:900px){ .panel{grid-template-columns:1fr} .btn{flex:1 1 auto} }
  </style>
  </head><body><div class="card">
  <h1>🤖 TG → WA Bridge</h1>
  <div class="row">
    <button class="btn" id="ping">Ping</button>
    <button class="btn" id="health">Health</button>
    <button class="btn" id="tgstatus">TG Status</button>
    <button class="btn" id="wastatus">WA Status</button>
    <button class="btn" id="wagroups">WA Groups</button>
    <button class="btn" id="sendwa">Send → WA</button>
    <button class="btn" id="resetwa">Reset WA</button>
    <button class="btn" id="reloginwa">Relogin WA</button>
    <button class="ghost" id="qrascii">QR ASCII</button>
    <button class="ghost" id="logsbtn">Logs</button>
  </div>

  <div class="statusline">WA: <strong id="wastate">${waConnectionStatus}</strong> · Telegram: <strong id="tgstate">${tgClient ? 'connected' : 'disconnected'}</strong></div>

  <div class="panel">
    <div class="col">
      <div><label class="small">Отправить текст в WhatsApp (в выбранную группу):</label>
      <textarea id="wa_text" placeholder="Текст для отправки..."></textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" id="btn_sendwa">Отправить в WA</button>
        <button class="ghost" id="btn_refresh">Обновить статус</button>
      </div>
      </div>

      <hr style="margin:12px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">

      <div><label class="small">Отправить текст в Telegram (источник):</label>
      <input id="tg_text" type="text" placeholder="Текст в TG..."/>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" id="btn_tgsend">Отправить в TG</button>
        <button class="ghost" id="btn_showrecent">Показать последние пересланные</button>
      </div>
      </div>
    </div>

    <div class="col">
      <div><strong>QR</strong>
        <div class="qr" id="qrbox">${ lastQR ? `<img src="/wa/qr-img?ts=${Date.now()}" style="max-width:320px;"/>` : `<div style="color:#9fb0c8">QR not generated</div>` }</div>
        <div class="small">QR автоматически обновляется — если появится, отсканируй в WhatsApp</div>
      </div>

      <hr style="margin:10px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">

      <div><strong>Логи / Статус</strong>
        <div class="small" id="statustxt">...</div>
        <div class="list log" id="logbox">загрузка логов...</div>
      </div>
    </div>
  </div>

  <script>
    async function api(path, opts){
      const res = await fetch(path, opts)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json().catch(()=>null)
    }

    document.getElementById('btn_sendwa').onclick = async () => {
      const t = document.getElementById('wa_text').value
      if(!t) return alert('Введите текст')
      try {
        await api('/wa/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: t }) })
        alert('Отправлено')
      } catch(e){ alert('Ошибка: '+e.message) }
    }
    document.getElementById('btn_tgsend').onclick = async () => {
      const t = document.getElementById('tg_text').value
      if(!t) return alert('Введите текст')
      try {
        await api('/tg/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: t }) })
        alert('Отправлено в TG')
      } catch(e){ alert('Ошибка: '+e.message) }
    }
    document.getElementById('btn_refresh').onclick = loadStatus
    document.getElementById('btn_showrecent').onclick = async ()=>{
      try {
        const arr = await api('/wa/recent-forwarded')
        document.getElementById('logbox').innerText = arr.map(x=> (new Date(x.ts)).toLocaleString() + ' → ' + x.text).join('\\n\\n') || 'пусто'
      } catch(e){ alert('Ошибка: '+e.message) }
    }
    document.getElementById('qrascii').onclick = async () => {
      window.open('/wa/qr-ascii', '_self')
    }
    document.getElementById('logsbtn').onclick = async () => {
      try {
        const txt = await fetch('/logs').then(r=>r.text())
        document.getElementById('logbox').innerText = txt.slice(-5000) || 'пусто'
      } catch(e){ document.getElementById('logbox').innerText='Ошибка загрузки' }
    }

    async function loadStatus(){
      try {
        const s = await api('/wa/status')
        document.getElementById('wastate').innerText = s.whatsapp
        const t = await api('/tg/status')
        document.getElementById('tgstate').innerText = t.telegram ? 'connected' : 'disconnected'
        const logs = await fetch('/logs/tail?lines=120').then(r=>r.text())
        document.getElementById('logbox').innerText = logs
        document.getElementById('statustxt').innerText = JSON.stringify(s)
        if (s.qrPending){
          const box = document.getElementById('qrbox')
          let img = box.querySelector('img')
          if(!img){ img = document.createElement('img'); img.style.maxWidth='320px'; box.innerHTML=''; box.appendChild(img) }
          img.src = '/wa/qr-img?ts=' + Date.now()
        }
      } catch(e){}
    }

    setInterval(loadStatus, 3000)
    loadStatus()
  </script>

  </div></body></html>`
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})

// ---- startup ----
;(async () => {
  try {
    infoLog(`🔧 Конфигурация: CONFIG_GROUP_ID=${CONFIG_GROUP_ID || ''} CONFIG_GROUP_NAME=${CONFIG_GROUP_NAME || ''} TELEGRAM_SOURCE=${TELEGRAM_SOURCE || ''}`)
    await startTelegram()
    await startWhatsApp({ reset: false })
    app.listen(Number(PORT), () => {
      infoLog(`🌐 HTTP доступен: ${UI_DOMAIN} (port ${PORT})`)
      appendLogLine('Available endpoints: /, /ping, /healthz, /tg/status, /tg/send, /wa/status, /wa/groups, /wa/send, /wa/qr, /wa/qr-img, /wa/qr-ascii, /wa/reset, /wa/relogin, /wa/auth-status, /wa/recent-forwarded, /wa/recent-messages, /logs, /logs/tail')
    })
  } catch (e) {
    errorLog('❌ Ошибка старта: ' + (e?.message || e))
    process.exit(1)
  }
})()

// ---- graceful shutdown ----
process.on('SIGINT', async () => {
  infoLog('👋 Завершение...')
  try { await sock?.end?.(); await tgClient?.disconnect?.() } catch (e) {}
  try { fs.rmSync(LOCK_FILE) } catch(e) {}
  process.exit(0)
})
process.on('SIGTERM', async () => {
  infoLog('👋 Завершение...')
  try { await sock?.end?.(); await tgClient?.disconnect?.() } catch (e) {}
  try { fs.rmSync(LOCK_FILE) } catch(e) {}
  process.exit(0)
})
