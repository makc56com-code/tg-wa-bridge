// index.js — полный файл (обновлённый)
// Внимание: требует в .env следующие переменные (как минимум):
// TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION, TELEGRAM_SOURCE
// GITHUB_TOKEN, GIST_ID (для хранения auth + state.json)
// AUTH_DIR (опционально), PORT, ADMIN_TOKEN (для non-UI token access), ADMIN_PASSWORD (пароль для UI)
// WHATSAPP_GROUP_NAME / WHATSAPP_GROUP_ID (опционально)

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
import session from 'express-session'

// ----------------- NOISY LOGS FILTER (не подавляем ошибки) -----------------
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
// apply filter only to log/info/warn — errors always show
console.log = (...args) => {
  try {
    const s = util.format(...args)
    if (shouldSuppressLogLine(s)) return
    _origLog(s)
  } catch (e) { _origLog(...args) }
}
console.info = (...args) => {
  try {
    const s = util.format(...args)
    if (shouldSuppressLogLine(s)) return
    _origInfo(s)
  } catch (e) { _origInfo(...args) }
}
console.warn = (...args) => {
  try {
    const s = util.format(...args)
    if (shouldSuppressLogLine(s)) return
    _origWarn(s)
  } catch (e) { _origWarn(...args) }
}
console.error = (...args) => { // never suppress errors
  try { _origError(util.format(...args)) } catch(e){ _origError(...args) }
}
// ----------------- end filter -----------------

// ---- env/config ----
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TELEGRAM_SOURCE,
  WA_GROUP_ID,
  WA_GROUP_NAME,
  WHATSAPP_GROUP_ID,
  WHATSAPP_GROUP_NAME,
  PORT = 3000,
  GITHUB_TOKEN,
  GIST_ID,
  AUTH_DIR = '/tmp/auth_info_baileys',
  ADMIN_TOKEN = 'admin-token',
  ADMIN_PASSWORD = '', // пароль для UI. если пуст — доступ к UI запрещён
  LOG_LEVEL
} = process.env

const CONFIG_GROUP_ID = (WA_GROUP_ID && WA_GROUP_ID.trim()) ? WA_GROUP_ID.trim()
  : (WHATSAPP_GROUP_ID && WHATSAPP_GROUP_ID.trim() ? WHATSAPP_GROUP_ID.trim() : null)
const CONFIG_GROUP_NAME = (WA_GROUP_NAME && WA_GROUP_NAME.trim()) ? WA_GROUP_NAME.trim()
  : (WHATSAPP_GROUP_NAME && WHATSAPP_GROUP_NAME.trim() ? WHATSAPP_GROUP_NAME.trim() : null)

try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
try { fs.mkdirSync('logs', { recursive: true }) } catch (e) {}
const LOG_FILE = path.join('logs', 'bridge.log')
const STATE_FILE_LOCAL = path.join(AUTH_DIR, 'state.json') // local cache (not committed)
const LOCK_FILE = path.join(AUTH_DIR, '.singleton.lock')

// ---- singleton lock ----
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

// --- in-memory caches
const MAX_CACHE = 200
const recentForwarded = []     // {text, ts}
const recentWAMessages = []    // {from, text, ts}

// ---- state (radar/test) ----
// We persist state in the user's private Gist (file: state.json).
let radarState = 'off' // 'on' or 'off'
let testMode = false

// ---- Gist helpers (auth files and state) ----
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
      // skip our state.json file (handled separately)
      if (filename === 'state.json') continue
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
      // skip state.json local file from auth dump
      if (f === 'state.json') continue
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

// ---- State (radar/test) persistence in Gist ----
let stateSaveTimer = null
function debounceSaveStateToGist() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer)
  stateSaveTimer = setTimeout(() => { saveStateToGist().catch(()=>{}) }, 1200)
}
async function saveStateToGist() {
  if (!GITHUB_TOKEN || !GIST_ID) {
    warnLog('GITHUB_TOKEN/GIST_ID not set — skipping state save to Gist')
    return
  }
  try {
    const data = { radarState, testMode }
    // write to local cache too
    try { fs.mkdirSync(AUTH_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE_LOCAL, JSON.stringify(data, null, 2), 'utf8') } catch(e){}
    const files = { 'state.json': { content: JSON.stringify(data, null, 2) } }
    await axios.patch(`https://api.github.com/gists/${GIST_ID}`, { files }, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      timeout: 15000
    })
    infoLog('✅ state.json сохранён в Gist')
  } catch (err) {
    warnLog('⚠️ Ошибка при сохранении state.json в Gist: ' + (err?.message || err))
  }
}
async function loadStateFromGist() {
  // try to load from Gist; fallback to local file
  if (GITHUB_TOKEN && GIST_ID) {
    try {
      const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
        timeout: 15000
      })
      const files = res.data.files || {}
      if (files['state.json'] && files['state.json'].content) {
        const content = files['state.json'].content
        try {
          const parsed = JSON.parse(content)
          radarState = parsed.radarState === 'on' ? 'on' : 'off'
          testMode = !!parsed.testMode
          infoLog('📥 state.json загружен из Gist: ' + JSON.stringify({ radarState, testMode }))
          // write local cache
          try { fs.mkdirSync(AUTH_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE_LOCAL, JSON.stringify(parsed, null, 2), 'utf8') } catch(e){}
          return
        } catch (e) {
          warnLog('⚠️ Некорректный state.json в Gist: ' + (e?.message || e))
        }
      } else {
        infoLog('ℹ️ state.json в Gist отсутствует — используем локальный/по умолчанию')
      }
    } catch (e) {
      warnLog('⚠️ Ошибка загрузки state.json из Gist: ' + (e?.message || e))
    }
  }
  // fallback local
  try {
    if (fs.existsSync(STATE_FILE_LOCAL)) {
      const content = fs.readFileSync(STATE_FILE_LOCAL, 'utf8')
      const parsed = JSON.parse(content)
      radarState = parsed.radarState === 'on' ? 'on' : 'off'
      testMode = !!parsed.testMode
      infoLog('📥 state.json загружен из локального кэша: ' + JSON.stringify({ radarState, testMode }))
      return
    }
  } catch (e) { warnLog('⚠️ Ошибка чтения локального state.json: ' + (e?.message || e)) }
  // defaults if nothing loaded
  radarState = 'off'
  testMode = false
  infoLog('ℹ️ state.json не найден — используем defaults (radar=off,testMode=false)')
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
      // only forward if radar is ON
      if (radarState !== 'on') {
        infoLog('ℹ️ Radar is OFF — message not forwarded')
        return
      }
      // if testMode, send test prefix before actual message
      if (testMode) {
        await sendToWhatsApp('[🔧service🔧]\n[🛠режим тестирования🛠]').catch(e => { warnLog('⚠️ test prefix failed: ' + (e?.message||e)) })
      }
      await sendToWhatsApp(String(text))
    } else {
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
        try { await cacheGroupId(true) } catch (e) { warnLog('⚠️ cacheGroupId failed: ' + (e?.message||e)) }
        lastQR = null
        isStartingWA = false
        // If radarState is ON, announce via service message
        if (radarState === 'on') {
          try { await sendToWhatsApp('[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]') } catch(e){ warnLog('⚠️ Не удалось отправить startup welcome: ' + (e?.message||e)) }
        }
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
        // only send welcome if radarState === 'on'
        if (radarState === 'on') {
          try { await sendToWhatsApp('[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]') } catch(e){ warnLog('⚠️ Не удалось отправить welcome: ' + (e?.message||e)) }
        } else {
          infoLog('ℹ️ Skipped welcome: radarState != on')
        }
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
app.use(session({
  secret: 'replace-with-strong-secret-or-use-env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 3600 * 1000 }
}))

// Simple middleware to require UI password (session-based)
function requireAuthForUI(req, res, next) {
  // if ADMIN_PASSWORD empty -> forbid access
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.trim() === '') {
    return res.status(403).send('UI password not configured')
  }
  if (req.session && req.session.authed) return next()
  // unauthenticated -> redirect to login
  return res.redirect('/login')
}

function checkTokenOrSession(req) {
  // returns true if request is authorized either via token query param or via session auth
  const token = req.query.token || req.body.token
  if (token && ADMIN_TOKEN && token === ADMIN_TOKEN) return true
  if (req.session && req.session.authed) return true
  return false
}

app.get('/login', (req, res) => {
  // show simple password-only login form
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Login</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>body{font-family:Inter,Arial;background:#071226;color:#e6eef8;display:flex;align-items:center;justify-content:center;height:100vh} .box{background:rgba(0,0,0,0.5);padding:20px;border-radius:10px;width:320px} input{width:100%;padding:10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit} button{padding:10px 14px;margin-top:10px;border-radius:8px;background:#06b6d4;color:#04202a;border:none;font-weight:700}</style>
  </head><body><div class="box"><h3 style="margin-top:0">Enter password</h3>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Password" />
    <button type="submit">Enter</button>
  </form>
  <p style="font-size:12px;color:#9fb0c8;margin-top:10px">Password-only access (no username)</p>
  </div></body></html>`
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.send(html)
})

app.post('/login', (req, res) => {
  const pwd = req.body.password || ''
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.trim() === '') {
    return res.status(403).send('UI password not configured on server')
  }
  if (pwd === ADMIN_PASSWORD) {
    req.session.authed = true
    return res.redirect('/')
  }
  return res.status(401).send('Invalid password')
})

app.get('/logout', (req, res) => {
  req.session.authed = false
  req.session.destroy && req.session.destroy()
  res.redirect('/login')
})

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
    configuredGroupName: CONFIG_GROUP_NAME || null,
    radarState,
    testMode
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
  if (!checkTokenOrSession(req)) return res.status(403).send({ error: 'forbidden' })
  try {
    if (sock) try { await sock.logout(); await sock.end() } catch (e) {}
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
    lastQR = null; cachedGroupJid = null
    scheduleRestart({ reset: true })
    res.send({ status: 'ok', message: 'reset scheduled' })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.post('/wa/relogin', async (req, res) => {
  if (!checkTokenOrSession(req)) return res.status(403).send({ error: 'forbidden' })
  try {
    if (sock) try { await sock.logout(); await sock.end() } catch (e) {}
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
    lastQR = null; cachedGroupJid = null
    scheduleRestart({ reset: true })
    res.send({ status: 'ok', message: 'relogin scheduled' })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/relogin-ui', (req, res) => {
  // trigger relogin using token from session or ADMIN_TOKEN if present
  const token = req.session?.authed ? ADMIN_TOKEN : ''
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
  if (!checkTokenOrSession(req)) return res.status(403).send({ error: 'forbidden' })
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

// ---- Radar / Test endpoints (require token or UI session) ----
const msgOn = '[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]'
const msgOff = '[🔧service🔧]\n[🌎подключено🌎]\n[⛔РАДАР ВЫКЛЮЧЕН⛔]'
const msgTestOn = '[🔧service🔧]\n[🛠testON🛠]\n[🤚ручной режим🤚]'
const msgTestOff = '[🔧service🔧]\n[🛠testOFF🛠]\n[🤖автоматический режим🤖]'
const msgTestPrefix = '[🔧service🔧]\n[🛠режим тестирования🛠]'

app.post('/radar/on', async (req, res) => {
  if (!checkTokenOrSession(req)) return res.status(403).send({ error: 'forbidden' })
  radarState = 'on'
  debounceSaveStateToGist()
  try {
    await sendToWhatsApp(msgOn)
  } catch (e) { warnLog('⚠️ send msgOn failed: ' + (e?.message || e)) }
  res.send({ status: 'ok', radarState })
})
app.post('/radar/off', async (req, res) => {
  if (!checkTokenOrSession(req)) return res.status(403).send({ error: 'forbidden' })
  radarState = 'off'
  debounceSaveStateToGist()
  try {
    await sendToWhatsApp(msgOff)
  } catch (e) { warnLog('⚠️ send msgOff failed: ' + (e?.message || e)) }
  res.send({ status: 'ok', radarState })
})
app.post('/radar/test-on', async (req, res) => {
  if (!checkTokenOrSession(req)) return res.status(403).send({ error: 'forbidden' })
  testMode = true
  debounceSaveStateToGist()
  try {
    await sendToWhatsApp(msgTestOn)
  } catch (e) { warnLog('⚠️ send msgTestOn failed: ' + (e?.message || e)) }
  res.send({ status: 'ok', testMode })
})
app.post('/radar/test-off', async (req, res) => {
  if (!checkTokenOrSession(req)) return res.status(403).send({ error: 'forbidden' })
  testMode = false
  debounceSaveStateToGist()
  try {
    await sendToWhatsApp(msgTestOff)
  } catch (e) { warnLog('⚠️ send msgTestOff failed: ' + (e?.message || e)) }
  res.send({ status: 'ok', testMode })
})

// ---- main UI — protected by session/password ----
app.get('/', requireAuthForUI, (req, res) => {
  const qrPending = !!lastQR
  // remove ADMIN_TOKEN exposure
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>TG→WA Bridge</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root{--bg:#071226;--card:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));--accent:#06b6d4;--muted:#9fb0c8;--btn-text:#04202a}
    body{font-family:Inter,Segoe UI,Roboto,Arial;background:var(--bg);color:#e6eef8;margin:0;padding:18px;display:flex;justify-content:center}
    .card{max-width:980px;width:100%;background:var(--card);border-radius:12px;padding:18px;box-sizing:border-box}
    header{display:flex;justify-content:space-between;align-items:center;gap:12px}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .btn{display:inline-flex;align-items:center;justify-content:center;margin:6px;padding:10px 14px;border-radius:10px;text-decoration:none;background:var(--accent);color:#04202a;font-weight:700;cursor:pointer;border:none}
    .ghost{display:inline-flex;align-items:center;justify-content:center;margin:6px;padding:10px 14px;border-radius:10px;text-decoration:none;background:var(--accent);color:#04202a;font-weight:700;cursor:pointer;border:none}
    .qr{margin-top:12px}
    .statusline{margin-top:12px;color:var(--muted)}
    .panel{display:grid;grid-template-columns:1fr 360px;gap:12px;margin-top:12px}
    .panel .col{background:rgba(0,0,0,0.12);padding:12px;border-radius:8px;min-height:120px}
    textarea{width:100%;height:90px;border-radius:8px;padding:8px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit;resize:vertical}
    input[type=text]{width:100%;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit}
    .small{font-size:13px;color:var(--muted)}
    .list{max-height:220px;overflow:auto;padding:6px}
    .log{white-space:pre-wrap;font-family:monospace;font-size:12px;color:#cfeefb;max-height:420px;overflow:auto;padding:8px;background:rgba(0,0,0,0.08);border-radius:6px}
    .full-logs{margin-top:12px}
    .mutedbox{color:var(--muted);font-size:13px}
    @media(max-width:900px){ .panel{grid-template-columns:1fr} .btn{flex:1 1 auto} .ghost{flex:1 1 auto} }
  </style>
  </head><body><div class="card">
  <header>
    <h1 style="margin:0">🤖 TG → WA Bridge</h1>
    <div class="mutedbox">UI: ${UI_DOMAIN} · Group: ${CONFIG_GROUP_NAME || CONFIG_GROUP_ID || 'not configured'}</div>
  </header>

  <div class="row" style="margin-top:8px">
    <button class="btn" id="ping">Ping</button>
    <button class="btn" id="health">Health</button>
    <button class="btn" id="tgstatus">TG Status</button>
    <button class="btn" id="wastatus">WA Status</button>
    <button class="btn" id="wagroups">WA Groups</button>
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

      <div><strong>Краткий статус</strong>
        <div class="small" id="statustxt">...</div>
      </div>

      <hr style="margin:10px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">

      <div><strong>Radar / Test</strong>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="radar_on">Radar ON</button>
          <button class="btn" id="radar_off">Radar OFF</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="test_on">RadarTest ON</button>
          <button class="btn" id="test_off">RadarTest OFF</button>
        </div>
        <div class="small" id="radar_state_box" style="margin-top:8px">radar: ${radarState} · testMode: ${testMode}</div>
      </div>
    </div>
  </div>

  <!-- Логи — под панелью, занимающие всю ширину -->
  <div class="full-logs">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>Логи / Статус</strong><span style="margin-left:8px;color:var(--muted)">(включая результат кнопок)</span></div>
      <div class="small">Последнее обновление: <span id="lastupd">—</span></div>
    </div>
    <div class="log" id="logbox">загрузка логов...</div>
  </div>

  <script>
    function fmtNow() { return new Date().toLocaleString(); }
    function appendToLogBox(s) {
      try {
        const box = document.getElementById('logbox')
        const ts = '[' + fmtNow() + '] '
        box.innerText = ts + s + '\\n\\n' + box.innerText
        if (box.innerText.length > 20000) box.innerText = box.innerText.slice(0, 20000)
      } catch(e){}
      document.getElementById('lastupd').innerText = fmtNow()
    }

    async function callApi(path, opts = {}) {
      const res = await fetch(path, opts)
      const text = await (res.headers.get('content-type') && res.headers.get('content-type').includes('application/json') ? res.json().catch(()=>null) : res.text().catch(()=>null))
      return { ok: res.ok, status: res.status, data: text }
    }

    document.getElementById('ping').onclick = async () => {
      appendToLogBox('-> ping ...')
      try {
        const r = await callApi('/ping')
        appendToLogBox('<- ping: ' + (r.ok ? String(r.data) : 'HTTP ' + r.status))
      } catch (e) { appendToLogBox('! ping error: ' + e.message) }
    }

    document.getElementById('health').onclick = async () => {
      appendToLogBox('-> health ...')
      try {
        const r = await callApi('/healthz')
        appendToLogBox('<- health: ' + (r.ok ? 'ok' : 'HTTP ' + r.status))
      } catch (e) { appendToLogBox('! health error: ' + e.message) }
    }

    document.getElementById('tgstatus').onclick = async () => {
      appendToLogBox('-> tg status ...')
      try {
        const r = await callApi('/tg/status')
        appendToLogBox('<- tg status: ' + JSON.stringify(r.data))
      } catch (e) { appendToLogBox('! tg status error: ' + e.message) }
    }

    document.getElementById('wastatus').onclick = async () => {
      appendToLogBox('-> wa status ...')
      try {
        const r = await callApi('/wa/status')
        appendToLogBox('<- wa status: ' + JSON.stringify(r.data))
        if (r.data && r.data.qrPending) {
          const box = document.getElementById('qrbox')
          let img = box.querySelector('img')
          if(!img){ img = document.createElement('img'); img.style.maxWidth='320px'; box.innerHTML=''; box.appendChild(img) }
          img.src = '/wa/qr-img?ts=' + Date.now()
        }
        document.getElementById('wastate').innerText = r.data.whatsapp
        document.getElementById('statustxt').innerText = JSON.stringify(r.data)
        document.getElementById('radar_state_box').innerText = 'radar: ' + r.data.radarState + ' · testMode: ' + r.data.testMode
      } catch (e) { appendToLogBox('! wa status error: ' + e.message) }
    }

    document.getElementById('wagroups').onclick = async () => {
      appendToLogBox('-> wa groups ...')
      try {
        const r = await callApi('/wa/groups')
        if (!r.ok) appendToLogBox('<- wa groups error: HTTP ' + r.status + ' ' + JSON.stringify(r.data))
        else appendToLogBox('<- wa groups: ' + JSON.stringify(r.data))
      } catch (e) { appendToLogBox('! wa groups error: ' + e.message) }
    }

    document.getElementById('resetwa').onclick = async () => {
      if (!confirm('Сбросить WA сессию? (требуется token)')) return
      appendToLogBox('-> reset WA requested')
      try {
        const r = await callApi('/wa/reset?token=' + encodeURIComponent('REPLACE_TOKEN'), { method: 'POST' })
        appendToLogBox('<- reset: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data)))
      } catch (e) { appendToLogBox('! reset error: ' + e.message) }
    }

    document.getElementById('reloginwa').onclick = async () => {
      if (!confirm('Релогин WA (новая авторизация — QR) — продолжить?')) return
      appendToLogBox('-> relogin WA requested')
      try {
        const r = await callApi('/wa/relogin-ui')
        appendToLogBox('<- relogin-ui: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status))
      } catch (e) { appendToLogBox('! relogin error: ' + e.message) }
    }

    document.getElementById('qrascii').onclick = async () => {
      appendToLogBox('-> open QR ASCII')
      window.open('/wa/qr-ascii', '_blank')
      appendToLogBox('<- QR ASCII opened in new tab')
    }

    document.getElementById('logsbtn').onclick = async () => {
      appendToLogBox('-> load server logs tail')
      try {
        const r = await fetch('/logs/tail?lines=400')
        const txt = await r.text()
        document.getElementById('logbox').innerText = txt || 'пусто'
        appendToLogBox('<- logs loaded (' + (txt.length) + ' bytes)')
      } catch (e) { appendToLogBox('! load logs error: ' + e.message) }
    }

    // отправка в WA
    document.getElementById('btn_sendwa').onclick = async () => {
      const raw = document.getElementById('wa_text').value
      if(!raw || !raw.trim()) { alert('Введите текст'); return }
      const wrapped = `[🔧service🔧]\\n[Сообщение: ${raw}]`
      appendToLogBox('-> send to WA: ' + wrapped.slice(0,200))
      try {
        const r = await callApi('/wa/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: wrapped }) })
        appendToLogBox('<- send WA result: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data)))
        if (r.ok) { alert('Отправлено'); document.getElementById('wa_text').value = '' }
      } catch (e) { appendToLogBox('! send WA error: ' + e.message) }
    }

    // отправка в TG
    document.getElementById('btn_tgsend').onclick = async () => {
      const raw = document.getElementById('tg_text').value
      if(!raw || !raw.trim()) { alert('Введите текст'); return }
      const wrapped = `[🔧service🔧]\\n[Сообщение: ${raw}]`
      appendToLogBox('-> send to TG: ' + wrapped.slice(0,200))
      try {
        const r = await callApi('/tg/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: wrapped }) })
        appendToLogBox('<- send TG result: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data)))
        if (r.ok) { alert('Отправлено в TG'); document.getElementById('tg_text').value = '' }
      } catch (e) { appendToLogBox('! send TG error: ' + e.message) }
    }

    document.getElementById('btn_showrecent').onclick = async ()=> {
      appendToLogBox('-> show recent forwarded (WA)')
      try {
        const r = await callApi('/wa/recent-forwarded')
        appendToLogBox('<- recent forwarded: ' + JSON.stringify(r.data || []))
        document.getElementById('logbox').innerText = (r.data || []).map(x=> (new Date(x.ts)).toLocaleString() + ' → ' + x.text).join('\\n\\n') || 'пусто'
      } catch(e){ appendToLogBox('! recent-forwarded error: ' + e.message) }
    }

    document.getElementById('btn_refresh').onclick = async () => {
      appendToLogBox('-> manual refresh status')
      await loadStatus(true)
    }

    // Radar/Test buttons (use session auth)
    document.getElementById('radar_on').onclick = async () => {
      appendToLogBox('-> radar on (UI)')
      const r = await callApi('/radar/on', { method: 'POST' })
      appendToLogBox('<- radar on: ' + JSON.stringify(r.data))
      await loadStatus(true)
    }
    document.getElementById('radar_off').onclick = async () => {
      appendToLogBox('-> radar off (UI)')
      const r = await callApi('/radar/off', { method: 'POST' })
      appendToLogBox('<- radar off: ' + JSON.stringify(r.data))
      await loadStatus(true)
    }
    document.getElementById('test_on').onclick = async () => {
      appendToLogBox('-> test on (UI)')
      const r = await callApi('/radar/test-on', { method: 'POST' })
      appendToLogBox('<- test on: ' + JSON.stringify(r.data))
      await loadStatus(true)
    }
    document.getElementById('test_off').onclick = async () => {
      appendToLogBox('-> test off (UI)')
      const r = await callApi('/radar/test-off', { method: 'POST' })
      appendToLogBox('<- test off: ' + JSON.stringify(r.data))
      await loadStatus(true)
    }

    async function loadStatus(forceLogs=false) {
      try {
        const s = await callApi('/wa/status')
        document.getElementById('wastate').innerText = s.data.whatsapp
        const t = await callApi('/tg/status')
        document.getElementById('tgstate').innerText = t.data && t.data.telegram ? 'connected' : 'disconnected'
        document.getElementById('statustxt').innerText = JSON.stringify(s.data)
        if (s.data && s.data.qrPending){
          const box = document.getElementById('qrbox')
          let img = box.querySelector('img')
          if(!img){ img = document.createElement('img'); img.style.maxWidth='320px'; box.innerHTML=''; box.appendChild(img) }
          img.src = '/wa/qr-img?ts=' + Date.now()
          appendToLogBox('QR pending — image refreshed')
        }
        if (forceLogs) {
          try {
            const r = await fetch('/logs/tail?lines=120')
            const logs = await r.text()
            document.getElementById('logbox').innerText = logs || 'пусто'
            appendToLogBox('Logs updated (manual)')
          } catch (e) { appendToLogBox('! logs fetch error: ' + e.message) }
        }
      } catch(e) {
        appendToLogBox('! loadStatus error: ' + (e.message || e))
      }
    }

    setInterval(() => loadStatus(false), 3000)
    loadStatus(true)
  </script>

  </div></body></html>`
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})

// ---- startup ----
;(async () => {
  try {
    infoLog(`🔧 Конфигурация: CONFIG_GROUP_ID=${CONFIG_GROUP_ID || ''} CONFIG_GROUP_NAME=${CONFIG_GROUP_NAME || ''} TELEGRAM_SOURCE=${TELEGRAM_SOURCE || ''}`)
    // load state from Gist/local
    await loadStateFromGist()
    await startTelegram()
    await startWhatsApp({ reset: false })
    app.listen(Number(PORT), () => {
      infoLog(`🌐 HTTP доступен: ${UI_DOMAIN} (port ${PORT})`)
      appendLogLine('Available endpoints: /, /login, /ping, /healthz, /tg/status, /tg/send, /wa/status, /wa/groups, /wa/send, /wa/qr, /wa/qr-img, /wa/qr-ascii, /wa/reset, /wa/relogin, /wa/auth-status, /wa/recent-forwarded, /wa/recent-messages, /logs, /logs/tail, /radar/on, /radar/off, /radar/test-on, /radar/test-off')
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
