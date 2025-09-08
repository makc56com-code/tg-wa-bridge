import fs from 'fs'
import axios from 'axios'
import qrcodeTerminal from 'qrcode-terminal'
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'

import { AUTH_DIR, CONFIG_GROUP_ID, CONFIG_GROUP_NAME, GITHUB_TOKEN, GIST_ID, LOG_LEVEL } from './config.js'
import { infoLog, warnLog, errorLog } from './logger.js'
import { sendTelegramNotification } from './telegram.js'

export let sock = null
export let lastQR = null
export let waConnectionStatus = 'disconnected'
export let cachedGroupJid = null

let isStartingWA = false
let saveAuthTimer = null
let restartTimer = null
let restartCount = 0
let conflictCount = 0

let lastConflictAt = 0
const PLOGGER = P({ level: LOG_LEVEL || 'error' })

// --- helpers to load/save auth from gist ---
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
    if (!files) return false
    fs.mkdirSync(dir, { recursive: true })
    for (const [filename, fileObj] of Object.entries(files)) {
      const fp = `${dir}/${filename}`
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
  if (!GITHUB_TOKEN || !GIST_ID) return
  try {
    if (!fs.existsSync(dir)) return
    const files = {}
    for (const f of fs.readdirSync(dir)) {
      const fp = `${dir}/${f}`
      if (!fs.statSync(fp).isFile()) continue
      files[f] = { content: fs.readFileSync(fp, 'utf8') }
    }
    if (Object.keys(files).length === 0) return
    await axios.patch(`https://api.github.com/gists/${GIST_ID}`, { files }, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      timeout: 15000
    })
    infoLog('✅ Auth сохранён в Gist')
  } catch (err) {
    warnLog('⚠️ Ошибка при сохранении auth в Gist: ' + (err?.message || err))
  }
}

// --- restart scheduling ---
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

// --- MAIN START FUNCTION ---
export async function startWhatsApp({ reset = false } = {}) {
  if (isStartingWA) {
    infoLog('ℹ️ startWhatsApp уже выполняется — возвращаемся')
    return
  }
  isStartingWA = true
  waConnectionStatus = 'connecting'
  infoLog(`🚀 Запуск WhatsApp... reset=${reset}`)

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
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, PLOGGER) },
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

  // --- events ---
  sock.ev.on('creds.update', async () => {
    try { await saveCreds() } catch (e) {}
    debounceSaveAuthToGist(AUTH_DIR)
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    try {
      if (qr) {
        lastQR = qr
        waConnectionStatus = 'awaiting_qr'
        infoLog('📱 QR сгенерирован (доступен на /wa/qr)')
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
        try { await cacheGroupId(true) } catch(e) {}
        lastQR = null
        isStartingWA = false
      }

      if (connection === 'close') {
        waConnectionStatus = 'disconnected'
        isStartingWA = false
        let code = null
        try { code = new Boom(lastDisconnect?.error)?.output?.statusCode } catch (e) {}
        warnLog('⚠️ WhatsApp соединение закрыто ' + (code || 'unknown'))
        try { await sock?.end?.() } catch (e) {}
        if (code === 440) {
          conflictCount++
          waConnectionStatus = 'conflict'
          await sendTelegramNotification(`⚠️ WhatsApp conflict (440). Требуется relogin.`).catch(()=>{})
          return
        } else if ([401,428].includes(code)) {
          scheduleRestart({ reset: true })
        } else {
          scheduleRestart({ reset: false })
        }
      }
    } catch (e) {
      errorLog('⚠️ Ошибка connection.update: ' + (e?.message || e))
      isStartingWA = false
      scheduleRestart({ reset: false })
    }
  })
}
// === GROUP CACHE HELPERS ===
function normalizeName(s) {
  if (!s) return ''
  return String(s).replace(/^[\s"'`]+|[\s"'`]+$/g, '').trim().toLowerCase()
}
function stripNonAlnum(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi,'').trim()
}

export async function cacheGroupId(sendWelcome=false) {
  try {
    if (!sock || waConnectionStatus !== 'connected') { 
      warnLog('WA not connected for group caching'); 
      return 
    }
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups || {})
    infoLog(`🔎 Найдено ${list.length} групп(ы)`)

    const cfgIdRaw = CONFIG_GROUP_ID || null
    const cfgId = cfgIdRaw ? (String(cfgIdRaw).endsWith('@g.us') ? cfgIdRaw : String(cfgIdRaw) + '@g.us') : null
    const cfgNameRaw = CONFIG_GROUP_NAME || null
    const cfgName = normalizeName(cfgNameRaw)
    infoLog(`🔍 Ищу группу по id=${cfgId} name="${cfgNameRaw}"`)

    let target = null
    if (cfgId) {
      target = list.find(g => g.id === cfgId)
      if (target) infoLog('✅ Найдено по JID: ' + cfgId)
    }

    if (!target && cfgName) {
      target = list.find(g => normalizeName(g.subject) === cfgName)
      if (target) infoLog(`✅ Найдено по имени: "${target.subject}"`)
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
      if (target) infoLog(`✅ Найдено по stripNonAlnum: "${target.subject}"`)
    }

    if (!target && list.length === 1) {
      target = list[0]
      infoLog('ℹ️ Выбрана единственная доступная группа: ' + (target.subject||''))
    }

    if (target) {
      cachedGroupJid = target.id
      infoLog('✅ Закэширован group: ' + (target.subject || '') + ' (' + target.id + ')')
      if (sendWelcome) {
        try { 
          await sendToWhatsApp('[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]') 
        } catch(e){ warnLog('⚠️ Не удалось отправить welcome: ' + (e?.message||e)) }
      }
    } else {
      cachedGroupJid = null
      warnLog('⚠️ Целевая группа не найдена')
    }
  } catch (e) {
    errorLog('❌ Ошибка cacheGroupId: ' + (e?.message || e))
  }
}
// === SEND MESSAGES ===
const MAX_CACHE = 200
export const recentForwarded = []
export const recentWAMessages = []

export async function sendToWhatsApp(text) {
  try {
    if (!sock || waConnectionStatus !== 'connected') { 
      warnLog('⏳ WA не готов — сообщение не отправлено') 
      return false 
    }
    const jid = cachedGroupJid || (CONFIG_GROUP_ID ? 
        (CONFIG_GROUP_ID.endsWith('@g.us') ? CONFIG_GROUP_ID : CONFIG_GROUP_ID + '@g.us') 
        : null)
    if (!jid) { errorLog('❌ Нет идентификатора группы'); return false }
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

// === STATUS HELPERS ===
export function getWaStatus() {
  return {
    whatsapp: waConnectionStatus,
    qrPending: !!lastQR,
    waGroup: cachedGroupJid ? { id: cachedGroupJid } : null,
    configuredGroupId: CONFIG_GROUP_ID || null,
    configuredGroupName: CONFIG_GROUP_NAME || null,
  }
}
