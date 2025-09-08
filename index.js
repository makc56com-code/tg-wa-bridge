// index.js (полностью обновлённый — UI и логика Radar включены)
// Я внёс минимальные изменения в остальную логику: добавил флаг radarActive, эндпоинты для включения/выключения радара,
// UI-кнопки и поправил CSS для "Краткий статус", чтобы ничего не вылазило за границы.
// Теперь добавлен парсер сообщений из Telegram (форматирование и отправка в WA).
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

// RADAR: по умолчанию активируем, чтобы поведение осталось как раньше (можешь выключить через UI)
let radarActive = true

// pending service message — если включили/выключили radar когда WA offline, отправим при подключении
let pendingServiceMessage = null

const PLOGGER = P({ level: LOG_LEVEL || 'error' })
const UI_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`

// --- in-memory short caches for monitoring
const MAX_CACHE = 200
const recentForwarded = []     // {text, ts}
const recentWAMessages = []    // {from, text, ts}

// ---- normalized name cache (optimization) ----
const _normalizedCache = new Map()
function normalizeNameCached(s) {
  if (!s) return ''
  if (_normalizedCache.has(s)) return _normalizedCache.get(s)
  const v = String(s).replace(/^[\s"'`]+|[\s"'`]+$/g, '').trim().toLowerCase()
  _normalizedCache.set(s, v)
  return v
}
function stripNonAlnum(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi,'').trim()
}

// ----------------- PARSER: Telegram -> formatted WA message -----------------
/**
 * parseTelegramMessage(rawText)
 * возвращает строку (готовую к отправке в WA) или null если не парсится
 */
function parseTelegramMessage(raw) {
  if (!raw || typeof raw !== 'string') return null
  let msg = String(raw).trim()

  // 1) отбросим префикс [Global Realm N]
  msg = msg.replace(/^\[Global Realm\s*\d+\]\s*/i, '').trim()

  // 2) найдем позицию From[ — всё до неё содержит тип и (задачу)
  const fromIdx = msg.indexOf('From[')
  if (fromIdx === -1) {
    // Иногда исходный текст может отличаться — вернём null, чтобы сохранить оригинал
    return null
  }
  const head = msg.slice(0, fromIdx).trim() // например "Attack (Attack)" или "Captain (Pillage Stockpile[90%])" или "Scouts (1)"
  const tail = msg.slice(fromIdx).trim() // начиная с "From[...]" до конца, содержит также time после '|'

  // 3) извлечём задачу в скобках, если есть
  const taskMatch = head.match(/\(([^)]+)\)/)
  const taskRaw = taskMatch ? taskMatch[1].trim() : null

  // 4) извлечём основной тип (например Attack, Captain, Scouts, Monks, Attack to Capital, Scouts to Capital, Monks to Capital)
  const typeRaw = head.replace(/\([^)]+\)/, '').trim().toLowerCase()

  // 5) применим отображения типов в заголовок
  function mapTypeToHeader(t) {
    if (!t) return '⚔ СООБЩЕНИЕ ⚔'
    const s = t.toLowerCase()
    if (s.startsWith('captain')) return '⚔ ВНИМАНИЕ КАПИТАН ⚔'
    if (s.startsWith('attack to capital') || s.includes('attack to capital')) return '⚔🌆 ВНИМАНИЕ АТАКА НА ГОРОД 🌃⚔'
    if (s.startsWith('attack')) return '⚔ ВНИМАНИЕ АРМИЯ ⚔'
    if (s.startsWith('scouts to capital') || s.includes('scouts to capital')) return '🐎🌆 РАЗВЕДКА ГОРОДА 🌃🐎'
    if (s.startsWith('scouts')) return '🐎 РАЗВЕДКА 🐎'
    if (s.startsWith('monks to capital') || s.includes('monks to capital')) return '☦🌆 МОНАХ ПРИБЫВАЕТ В ГОРОД 🌃☦'
    if (s.startsWith('monks')) return '☦ МОНАХ ПРИБЫВАЕТ В ДЕРЕВНЮ ☦'
    return '⚔ СООБЩЕНИЕ ⚔'
  }
  const header = mapTypeToHeader(typeRaw)

  // 6) разобъём tail: From[AttackerName][AttackerId] <fromVillage> to [DefId] <toVillage> | time
  // пример tail: From[СексКАМАЗ][25460] 01 УБ Дрочильня to [105065] 2 Проток Дерьма| 00:04:23
  // regex позволит захватить группы аккуратно
  const tailRegex = /From\[(.*?)\]\[(\d+)\]\s+(.+?)\s+to\s+\[(\d+)\]\s+(.+?)(?:\s*\|\s*([0-9]{2}:[0-9]{2}:[0-9]{2}))?$/i
  const tailMatch = tail.match(tailRegex)
  if (!tailMatch) {
    // если основной шаблон не подошёл — попытаемся вытащить время и части альтернативно
    // попробуем найти time в конце
    const timeAlt = msg.match(/([0-9]{2}:[0-9]{2}:[0-9]{2})\s*$/)
    const timeStr = timeAlt ? timeAlt[1] : ''
    // попроще — не парсим, отдаём null чтобы не ломать поток
    return null
  }

  const attackerName = tailMatch[1] || ''
  const attackerId = tailMatch[2] || ''
  const fromVillage = (tailMatch[3] || '').trim()
  const defenderId = tailMatch[4] || ''
  const toVillage = (tailMatch[5] || '').trim()
  const travelTime = (tailMatch[6] || '').trim()

  // 7) сформируем строку "задачи" (taskText) по входному taskRaw
  let taskText = ''
  if (!taskRaw) {
    // для Scout/Monks часто в скобках просто число — это handled ниже
    if (typeRaw.startsWith('scouts')) {
      // извлечём число разведчиков, если есть
      const countMatch = head.match(/Scouts\s*\(?\s*(\d+)\s*\)?/i)
      const cnt = countMatch ? countMatch[1] : null
      taskText = cnt ? `📋 Разведчик(и):[количество не определяеться]: ${cnt} 📋` : ''
    } const mCnt = head.match(/Monks\s*\(?\s*(\d+)\s*\)?/i)
    const cnt = mCnt ? mCnt[1] : null
    lines.push(`📋 Задача: [не определяеться] 📋`)
    lines.push(`📋 Количество монахов: ${cnt ? cnt : '[не указано]'} 📋`)
    lines.push(`🗡 Нападает: ${attackerName} ID ${attackerId} из ${fromVillage} 🗡`)
    lines.push(`🛡 Обороняеться: ${toVillage} ID ${defenderId} 🛡`)
    if (travelTime) lines.push(`⏰ Время пути: ${travelTime} ⏰`)
    return lines.join('\n')
  }
    }
  } else {
    const t = taskRaw // e.g. "Attack" or "Ransack[1%]" or "Pillage Stockpile[90%]" or "Gold Raid[50%]" or "Capture" or "Raze"
    const low = t.toLowerCase()
    if (low === 'attack') {
      taskText = '📋Задача: РАЗРУШЕНИЕ 📋'
    } else if (low.startsWith('ransack')) {
      // сохраним [X%] или [1%] часть если есть
      const pct = t.match(/\[.*?\]/)
      taskText = `📋 Задача: 🔥 ПОДЖЕГ 🔥${pct ? ' кол-во построек: ' + pct[0] : ''} 📋`
    } else if (low.startsWith('pillage stockpile')) {
      const pct = t.match(/\[.*?\]/)
      taskText = `📋 Задача: 🪨🌳 ГРАБЕЖ СКЛАДА 🌳🪨${pct ? ' кол-во: ' + pct[0] : ''} 📋`
    } else if (low.startsWith('pillage granary')) {
      const pct = t.match(/\[.*?\]/)
      taskText = `📋 Задача: 🍎🥩 ГРАБЕЖ АМБАРА 🥖🧀${pct ? ' кол-во: ' + pct[0] : ''} 📋`
    } else if (low.startsWith('pillage inn')) {
      const pct = t.match(/\[.*?\]/)
      taskText = `📋 Задача: 🍻 ГРАБЕЖ ТРАКТИРА 🍻${pct ? ' кол-во: ' + pct[0] : ''} 📋`
    } else if (low.startsWith('pillage armoury')) {
      const pct = t.match(/\[.*?\]/)
      taskText = `📋 Задача: 🔫 ГРАБЕЖ ОРУЖЕЙНОЙ 🔫${pct ? ' кол-во: ' + pct[0] : ''} 📋`
    } else if (low.startsWith('pillage village hole')) {
      const pct = t.match(/\[.*?\]/)
      taskText = `📋 Задача: 🍷🧂 ГРАБЕЖ БАНКЕТА 🪑🥻${pct ? ' кол-во: ' + pct[0] : ''} 📋`
    } else if (low.startsWith('capture')) {
      taskText = '📋 Задача: ЗАХВАТ 📋'
    } else if (low.startsWith('raze')) {
      taskText = '📋 Задача: УНИЧТОЖЕНИЕ 📋'
    } else if (low.startsWith('gold raid')) {
      const pct = t.match(/\[.*?\]/)
      taskText = `📋 Задача: 💰 НАБЕГ ЗА ЗОЛОТОМ 💰${pct ? ' кол-во: ' + pct[0] : ''} 📋`
    } else if (/^\d+$/.test(t) && typeRaw.startsWith('scouts')) {
      taskText = `📋 Разведчик(и): [количество не определяеться]: ${t} 📋`
    } else {
      // generic
      taskText = `📋 Задача: ${t} 📋`
    }
  }

  // 8) Форматируем итог (с учётом того, что для Scouts/Monks мы не хотим писать "нападает/оборона" как для армии — но по ТЗ поведение одинаковое за исключением заголовка)
  // Создаём строки в требуемом формате
  const lines = []
  lines.push(header)
  if (taskText) lines.push(taskText)
  // Нападает: Имя ID id из village
  lines.push(`🗡 Нападает: ${attackerName} ID ${attackerId} из ${fromVillage} 🗡`)
  // Обороняется: имя и ID — у тебя нужно: "2 Проток Дерьма ID 105065" — toVillage содержит "2 Проток Дерьма"
  lines.push(`🛡 Обороняеться: ${toVillage} ID ${defenderId} 🛡`)
  if (travelTime) lines.push(`⏰ Время пути: ${travelTime} ⏰`)
  const result = lines.join('\n')
  return result
}
// ----------------- end parser -----------------

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

      // Попробуем распарсить сообщение и отправить форматированное сообщение в WA (только если radarActive)
      try {
        const formatted = parseTelegramMessage(String(text).trim())
        if (formatted) {
          infoLog('ℹ️ Parsed TG -> formatted WA message:\n' + formatted.replace(/\n/g,' | '))
          if (radarActive) {
            // если WA не подключён — sendToWhatsApp вернёт false и мы просто логируем
            const ok = await sendToWhatsApp(formatted)
            if (!ok) {
              warnLog('⚠️ Не удалось отправить parsed message в WA (WA offline или ошибка)')
            }
          } else {
            infoLog('ℹ️ Radar выключен — сообщение распарсено но не отправлено (radarActive=false)')
          }
        } else {
          // если не удалось распарсить — отправляем сырое сообщение (как раньше) только если radarActive
          infoLog('ℹ️ Сообщение не подошло под шаблон парсера, пересылаем оригинал (если radarActive)')
          if (radarActive) {
            const ok = await sendToWhatsApp(String(text))
            if (!ok) warnLog('⚠️ Не удалось отправить оригинал в WA (WA offline или ошибка)')
          } else {
            infoLog('ℹ️ Radar выключен — оригинал не отправлен')
          }
        }
      } catch (e) {
        errorLog('❌ Ошибка в обработчике парсинга TG message: ' + (e?.message || e))
      }
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
// safe close socket + cleanup listeners
async function safeCloseSock() {
  try {
    if (!sock) return
    try {
      // remove listeners to avoid memory leaks / duplicated handlers
      if (sock.ev && typeof sock.ev.removeAllListeners === 'function') {
        try { sock.ev.removeAllListeners() } catch(e){}
      }
      try { await sock.logout(); } catch(e){}
      try { await sock.end(); } catch(e){}
    } catch (e) {}
  } finally {
    sock = null
  }
}

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

  // если есть старая sock — аккуратно закрываем и удаляем listeners
  try { await safeCloseSock() } catch(e){}

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
        try { await cacheGroupId(radarActive) } catch (e) { warnLog('⚠️ cacheGroupId failed: ' + (e?.message || e)) }
        // если есть отложенное сервисное сообщение — отправим (on/off уведомления)
        if (pendingServiceMessage && cachedGroupJid) {
          try {
            await sendToWhatsApp(pendingServiceMessage)
            pendingServiceMessage = null
          } catch (e) {
            warnLog('⚠️ Не удалось отправить pendingServiceMessage: ' + (e?.message || e))
          }
        }
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
    const cfgName = normalizeNameCached(cfgNameRaw)
    infoLog(`🔍 Ищу target by id=${cfgId} name="${cfgNameRaw}" (normalized="${cfgName}")`)

    let target = null
    if (cfgId) {
      target = list.find(g => g.id === cfgId)
      if (target) {
        infoLog('✅ Найдено по JID: ' + cfgId)
      }
    }

    if (!target && cfgName) {
      // точное совпадение
      const exactMatches = list.filter(g => normalizeNameCached(g.subject) === cfgName)
      if (exactMatches.length === 1) {
        target = exactMatches[0]
        infoLog(`✅ Найдено по точному имени: "${target.subject}"`)
      } else if (exactMatches.length > 1) {
        // если несколько точных совпадений — логируем и возьмём первый, но предупреждение
        target = exactMatches[0]
        warnLog(`⚠️ Несколько точных совпадений при поиске группы по имени: ${exactMatches.map(x=>x.subject).join('; ')} — выбран первый: "${target.subject}"`)
      }
    }

    if (!target && cfgName) {
      const starts = list.filter(g => normalizeNameCached((g.subject||'')).startsWith(cfgName))
      if (starts.length === 1) { target = starts[0]; infoLog(`✅ Найдено по startsWith: "${target.subject}"`) }
      else if (starts.length > 1) { target = starts[0]; warnLog(`⚠️ Несколько совпадений startsWith: выбрана первая "${target.subject}"`) }
    }

    if (!target && cfgName) {
      const includes = list.filter(g => normalizeNameCached((g.subject||'')).includes(cfgName))
      if (includes.length === 1) { target = includes[0]; infoLog(`✅ Найдено по contains: "${target.subject}"`) }
      else if (includes.length > 1) { target = includes[0]; warnLog(`⚠️ Несколько совпадений contains: выбрана первая "${target.subject}"`) }
    }

    if (!target && cfgName) {
      const wanted = stripNonAlnum(cfgName)
      const stripped = list.filter(g => stripNonAlnum(g.subject) === wanted)
      if (stripped.length === 1) { target = stripped[0]; infoLog(`✅ Найдено по stripNonAlnum exact: "${target.subject}"`) }
      else if (stripped.length > 1) { target = stripped[0]; warnLog(`⚠️ Несколько совпадений stripNonAlnum: выбрана первая "${target.subject}"`) }
    }

    if (!target && list.length === 1) {
      target = list[0]
      infoLog('ℹ️ Выбрана единственная доступная группа: ' + (target.subject||'') + ' ('+target.id+')')
    }

    if (target) {
      cachedGroupJid = target.id
      infoLog('✅ Закэширован target group: ' + (target.subject || '') + ' (' + target.id + ')')
      if (sendWelcome && radarActive) {
        try { await sendToWhatsApp('[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]') } catch(e){ warnLog('⚠️ Не удалось отправить welcome: ' + (e?.message||e)) }
      } else if (sendWelcome && pendingServiceMessage) {
        // если есть pending message — отправим её (редкий кейс)
        try { await sendToWhatsApp(pendingServiceMessage); pendingServiceMessage = null } catch(e){ warnLog('⚠️ Не удалось отправить pendingServiceMessage после кеширования группы: ' + (e?.message||e)) }
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
    configuredGroupName: CONFIG_GROUP_NAME || null,
    radarActive: !!radarActive
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
    // аккуратно закрываем старую сессию и очищаем listeners
    try { await safeCloseSock() } catch (e) { warnLog('⚠️ safeCloseSock failed during reset: ' + (e?.message || e)) }
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
    try { await safeCloseSock() } catch (e) { warnLog('⚠️ safeCloseSock failed during relogin: ' + (e?.message || e)) }
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

// RADAR endpoints
app.post('/wa/radar/on', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    radarActive = true
    infoLog('🔔 Radar turned ON via API')
    const msg = '[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]'
    // try to ensure WA is running
    try { startWhatsApp({ reset: false }).catch(()=>{}) } catch(e){}
    // if connected — send the radar-on message, otherwise store pendingServiceMessage to send on connect
    if (waConnectionStatus === 'connected') {
      await sendToWhatsApp(msg)
    } else {
      pendingServiceMessage = msg
      infoLog('ℹ️ WA not connected — pendingServiceMessage saved (will send on next connect)')
    }
    res.send({ status: 'ok', radarActive })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.post('/wa/radar/off', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    radarActive = false
    infoLog('🔕 Radar turned OFF via API')
    const msg = '[🔧service🔧]\n[🚨РАДАР отключен🚨]\n[🤚ручной режим🤚]'
    // send radar-off message if possible, otherwise save pending message
    if (waConnectionStatus === 'connected') {
      await sendToWhatsApp(msg)
    } else {
      pendingServiceMessage = msg
      warnLog('WA not connected — radar-off message saved to send on next connect.')
    }
    res.send({ status: 'ok', radarActive })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.get('/wa/radar/status', (req, res) => {
  res.send({ radarActive: !!radarActive })
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

// main UI — улучшенная панель: логи занимают нижнюю полосу, кнопки дают вывод в лог
app.get('/', (req, res) => {
  const qrPending = !!lastQR
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

    /* CORRECTION: prevent statustxt overflow */
    #statustxt { max-height:140px; overflow:auto; word-break:break-word; white-space:pre-wrap; color:var(--muted); font-size:13px; margin-top:6px; border-radius:6px; padding:6px; background:rgba(0,0,0,0.04); }

    /* simple toggle style */
    .toggle-wrap{display:flex;align-items:center;gap:10px;margin-top:8px}
    .switch{position:relative;width:56px;height:30px;border-radius:20px;background:rgba(255,255,255,0.06);cursor:pointer;display:inline-block}
    .switch .knob{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:left .18s ease}
    .switch.on{background:linear-gradient(90deg,#06b6d4,#0ea5a4)}
    .switch.on .knob{left:29px}
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
    <button class="btn" id="focus_sendwa">Send → WA</button>
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
        <div id="statustxt">...</div>

        <!-- Radar toggle -->
        <div class="toggle-wrap">
          <div id="radarSwitch" class="switch" title="Toggle Radar"><div class="knob"></div></div>
          <div>
            <div style="font-weight:700" id="radarLabel">RADAR</div>
            <div class="small" id="radarSub">загрузка...</div>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="radarOnBtn">Radar ON</button>
          <button class="ghost" id="radarOffBtn">Radar OFF</button>
        </div>

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
    // Вставляем ADMIN_TOKEN в клиент (если хочешь убрать — скажи)
    const ADMIN_TOKEN = ${JSON.stringify(ADMIN_TOKEN || '')};

    function fmtNow() {
      return new Date().toLocaleString();
    }
    function appendToLogBox(s) {
      try {
        const box = document.getElementById('logbox')
        const ts = '[' + fmtNow() + '] '
        box.innerText = ts + s + '\\n\\n' + box.innerText
        // trim to avoid бесконечный рост в UI
        if (box.innerText.length > 20000) box.innerText = box.innerText.slice(0, 20000)
      } catch(e){}
      document.getElementById('lastupd').innerText = fmtNow()
    }

    async function callApi(path, opts = {}) {
      const res = await fetch(path, opts)
      const text = await (res.headers.get('content-type') && res.headers.get('content-type').includes('application/json') ? res.json().catch(()=>null) : res.text().catch(()=>null))
      return { ok: res.ok, status: res.status, data: text }
    }

    // helper: enable/disable WA-related controls based on connected state
    function setWAControlsEnabled(enabled) {
      try {
        document.getElementById('btn_sendwa').disabled = !enabled
        document.getElementById('wa_text').disabled = !enabled
        // radar controls still work even when WA disconnected (they'll set pending message)
        document.getElementById('radarOnBtn').disabled = false
        document.getElementById('radarOffBtn').disabled = false
      } catch(e){}
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
        // если есть qrPending — покажем QR картинку
        if (r.data && r.data.qrPending) {
          const box = document.getElementById('qrbox')
          let img = box.querySelector('img')
          if(!img){ img = document.createElement('img'); img.style.maxWidth='320px'; box.innerHTML=''; box.appendChild(img) }
          img.src = '/wa/qr-img?ts=' + Date.now()
        }
        // обновим краткий статус
        document.getElementById('wastate').innerText = r.data.whatsapp
        document.getElementById('statustxt').innerText = JSON.stringify(r.data)
        // radar flag
        setRadarUi(!!r.data.radarActive)
        // enable/disable controls depending on wa connection
        setWAControlsEnabled(r.data.whatsapp === 'connected')
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

    // верхняя кнопка "Send → WA" — просто фокусирует поле отправки
    document.getElementById('focus_sendwa').onclick = () => {
      document.getElementById('wa_text').focus()
      appendToLogBox('-> focus to WA send box')
    }

    document.getElementById('resetwa').onclick = async () => {
      if (!confirm('Сбросить WA сессию? (требуется ADMIN_TOKEN)')) return
      appendToLogBox('-> reset WA requested')
      try {
        const r = await callApi('/wa/reset?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' })
        appendToLogBox('<- reset: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data)))
      } catch (e) { appendToLogBox('! reset error: ' + e.message) }
    }

    document.getElementById('reloginwa').onclick = async () => {
      if (!confirm('Релогин WA (новая авторизация — QR) — продолжить?')) return
      appendToLogBox('-> relogin WA requested')
      try {
        // используем удобный UI маршрут, он вызывает внутренний POST с токеном
        const r = await callApi('/wa/relogin-ui')
        appendToLogBox('<- relogin-ui: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status))
      } catch (e) { appendToLogBox('! relogin error: ' + e.message) }
    }

    document.getElementById('qrascii').onclick = async () => {
      appendToLogBox('-> open QR ASCII')
      // откроем в текущем окне (как раньше), но также покажем в лог
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

    // отправка в WA: оборачиваем текст по требованию
    document.getElementById('btn_sendwa').onclick = async () => {
      const raw = document.getElementById('wa_text').value
      if(!raw || !raw.trim()) { alert('Введите текст'); return }
      const wrapped = \`[🔧service🔧]\\n[Сообщение: \${raw}]\`
      appendToLogBox('-> send to WA: ' + wrapped.slice(0,200))
      try {
        const r = await callApi('/wa/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: wrapped }) })
        appendToLogBox('<- send WA result: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data)))
        if (r.ok) { alert('Отправлено'); document.getElementById('wa_text').value = '' }
      } catch (e) { appendToLogBox('! send WA error: ' + e.message) }
    }

    // отправка в TG: оборачиваем текст по требованию
    document.getElementById('btn_tgsend').onclick = async () => {
      const raw = document.getElementById('tg_text').value
      if(!raw || !raw.trim()) { alert('Введите текст'); return }
      const wrapped = \`[🔧service🔧]\\n[Сообщение: \${raw}]\`
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

    // кнопка Обновить статус
    document.getElementById('btn_refresh').onclick = async () => {
      appendToLogBox('-> manual refresh status')
      await loadStatus(true)
    }

    // RADAR UI handlers
    const radarSwitch = document.getElementById('radarSwitch')
    const radarLabel = document.getElementById('radarLabel')
    const radarSub = document.getElementById('radarSub')
    const radarOnBtn = document.getElementById('radarOnBtn')
    const radarOffBtn = document.getElementById('radarOffBtn')

    function setRadarUi(isOn) {
      if (isOn) {
        radarSwitch.classList.add('on')
        radarLabel.innerText = 'RADAR — ON'
        radarSub.innerText = 'Автоматическая отправка активна'
        appendToLogBox('ℹ️ Radar UI: ON')
      } else {
        radarSwitch.classList.remove('on')
        radarLabel.innerText = 'RADAR — OFF'
        radarSub.innerText = 'Ручной режим'
        appendToLogBox('ℹ️ Radar UI: OFF')
      }
    }

    radarSwitch.onclick = async () => {
      // toggle
      const currentlyOn = radarSwitch.classList.contains('on')
      if (currentlyOn) {
        await toggleRadar(false)
      } else {
        await toggleRadar(true)
      }
    }

    radarOnBtn.onclick = async () => { await toggleRadar(true) }
    radarOffBtn.onclick = async () => { await toggleRadar(false) }

    async function toggleRadar(on) {
      appendToLogBox('-> toggle radar -> ' + (on ? 'ON' : 'OFF'))
      try {
        const url = on ? '/wa/radar/on' : '/wa/radar/off'
        const r = await callApi(url + '?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' })
        if (!r.ok) {
          appendToLogBox('<- radar toggle error: HTTP ' + r.status + ' ' + JSON.stringify(r.data))
        } else {
          appendToLogBox('<- radar toggled: ' + JSON.stringify(r.data))
          setRadarUi(!!(r.data && r.data.radarActive))
        }
      } catch (e) { appendToLogBox('! radar toggle error: ' + e.message) }
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
        // update radar UI
        setRadarUi(!!(s.data && s.data.radarActive))
        // enable/disable WA controls (so user doesn't try to send when disconnected)
        setWAControlsEnabled(s.data.whatsapp === 'connected')
        // always pull logs if forced
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

    // автоподгрузка статуса каждую 3с
    setInterval(() => loadStatus(false), 3000)
    // начальная загрузка
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
    await startTelegram()
    await startWhatsApp({ reset: false })
    app.listen(Number(PORT), () => {
      infoLog(`🌐 HTTP доступен: ${UI_DOMAIN} (port ${PORT})`)
      appendLogLine('Available endpoints: /, /ping, /healthz, /tg/status, /tg/send, /wa/status, /wa/groups, /wa/send, /wa/qr, /wa/qr-img, /wa/qr-ascii, /wa/reset, /wa/relogin, /wa/auth-status, /wa/recent-forwarded, /wa/recent-messages, /logs, /logs/tail, /wa/radar/on, /wa/radar/off, /wa/radar/status')
    })
  } catch (e) {
    errorLog('❌ Ошибка старта: ' + (e?.message || e))
    process.exit(1)
  }
})()

// ---- graceful shutdown ----
process.on('SIGINT', async () => {
  infoLog('👋 Завершение...')
  try { await safeCloseSock(); await tgClient?.disconnect?.() } catch (e) {}
  try { fs.rmSync(LOCK_FILE) } catch(e) {}
  process.exit(0)
})
process.on('SIGTERM', async () => {
  infoLog('👋 Завершение...')
  try { await safeCloseSock(); await tgClient?.disconnect?.() } catch (e) {}
  try { fs.rmSync(LOCK_FILE) } catch(e) {}
  process.exit(0)
})
