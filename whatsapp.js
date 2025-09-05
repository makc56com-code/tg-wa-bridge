import fs from 'fs'
import path from 'path'
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import P from 'pino'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { AUTH_DIR, UI_DOMAIN } from './config.js'
import { infoLog, warnLog, errorLog } from './logger.js'
import { loadAuthFromGistToDir, debounceSaveAuthToGist, saveAuthToGist } from './gist.js'
import bus from './eventBus.js'
import { normalizeName, stripNonAlnum } from './utils.js'

const PLOGGER = P({ level: 'error' })

// state
export let sock = null
export let waConnectionStatus = 'disconnected'
export let isStartingWA = false
export let cachedGroupJid = null
export let lastQR = null

let restartTimer = null
let restartCount = 0
let conflictCount = 0
let lastConflictAt = 0

// RADAR service state
export let radarActive = true
let lastSentRadarState = null
let pendingServiceMessage = null

const MAX_CACHE = 200
const recentForwarded = []
const recentWAMessages = []

// restart scheduler
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

// main starter
export async function startWhatsApp({ reset = false } = {}) {
  if (isStartingWA) {
    infoLog('ℹ️ startWhatsApp уже выполняется — возвращаемся')
    return
  }
  isStartingWA = true
  waConnectionStatus = 'connecting'
  infoLog(`🚀 Запуск WhatsApp... reset=${reset}`)
  infoLog(`🔎 Ищем группу по CONFIG_GROUP_ID='${process.env.WA_GROUP_ID || ''}' CONFIG_GROUP_NAME='${process.env.WA_GROUP_NAME || process.env.WHATSAPP_GROUP_NAME || ''}'`)

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
        // notify TG via bus
        bus.emit('wa.notification', '⚠️ Новый QR для WhatsApp')
      }

      if (connection === 'open') {
        waConnectionStatus = 'connected'
        restartCount = 0
        conflictCount = 0
        infoLog('✅ WhatsApp подключён')
        try { await saveCreds() } catch (e) {}
        debounceSaveAuthToGist(AUTH_DIR)
        try {
          await cacheGroupId(radarActive, true)
        } catch (e) { warnLog('⚠️ cacheGroupId failed: ' + (e?.message || e)) }

        if (pendingServiceMessage) {
          try {
            await sendServiceMessage(pendingServiceMessage)
            pendingServiceMessage = null
          } catch (e) { warnLog('⚠️ failed to send pending service message: ' + (e?.message || e)) }
        }

        lastQR = null
        isStartingWA = false
      }

      if (connection === 'close') {
        waConnectionStatus = 'disconnected'
        isStartingWA = false
        let code = null
        try { code = new Error(lastDisconnect?.error)?.code } catch (e) { code = lastDisconnect?.error?.output?.statusCode || null }
        warnLog('⚠️ WhatsApp соединение закрыто ' + (code || 'unknown'))
        try { await sock?.end?.() } catch (e) {}

        if (code === 440) {
          lastConflictAt = Date.now()
          conflictCount = (conflictCount || 0) + 1
          warnLog('⚠️ Stream conflict (440). conflictCount=' + conflictCount)
          waConnectionStatus = 'conflict'
          bus.emit('wa.notification', `⚠️ WhatsApp session conflict detected (440). conflictCount=${conflictCount}. Требуется relogin.`)
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

  // subscribe to TG messages
  bus.on('tg.message', async (text) => {
    try {
      if (!text) return
      if (!radarActive) {
        infoLog('ℹ️ Radar is OFF — skipping forward of TG message.')
        return
      }
      await sendToWhatsApp(String(text))
    } catch (e) {
      warnLog('⚠️ Error forwarding TG->WA: ' + (e?.message || e))
    }
  })
}

// cache group id logic
export async function cacheGroupId(sendWelcome=false) {
  try {
    if (!sock || waConnectionStatus !== 'connected') { warnLog('WA not connected for group caching'); return }
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups || {})
    infoLog(`🔎 Найдено ${list.length} групп(ы)`)

    const candidates = list.map(g => ({ id: g.id, name: g.subject || '' }))
    infoLog('📋 Доступные группы: ' + candidates.map(c => `${c.name}|${c.id}`).join(', '))

    const cfgIdRaw = process.env.WA_GROUP_ID || process.env.WHATSAPP_GROUP_ID || null
    const cfgId = cfgIdRaw ? (String(cfgIdRaw).endsWith('@g.us') ? cfgIdRaw : String(cfgIdRaw) + '@g.us') : null
    const cfgNameRaw = process.env.WA_GROUP_NAME || process.env.WHATSAPP_GROUP_NAME || null
    const cfgName = normalizeName(cfgNameRaw)
    infoLog(`🔍 Ищу target by id=${cfgId} name="${cfgNameRaw}" (normalized="${cfgName}")`)

    let target = null
    if (cfgId) {
      target = list.find(g => g.id === cfgId)
      if (target) infoLog('✅ Найдено по JID: ' + cfgId)
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
      if (sendWelcome && radarActive) {
        try { await sendServiceMessage('on') } catch(e){ warnLog('⚠️ Не удалось отправить welcome: ' + (e?.message||e)) }
      }
    } else {
      cachedGroupJid = null
      warnLog('⚠️ Целевая группа не найдена; доступные: ' + candidates.map(g => `${g.name}|${g.id}`).join(', '))
    }
  } catch (e) {
    errorLog('❌ Ошибка cacheGroupId: ' + (e?.message || e))
  }
}

// service message logic
export async function sendServiceMessage(status) {
  if (!['on','off'].includes(status)) return false
  if (lastSentRadarState === status) {
    infoLog(`ℹ️ Service message for state='${status}' already sent — skipping.`)
    return false
  }

  const msgOn = '[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]'
  const msgOff = '[🔧service🔧]\n[🚨РАДАР отключен🚨]\n[🤚ручной режим🤚]'
  const payload = status === 'on' ? msgOn : msgOff

  if (waConnectionStatus === 'connected' && cachedGroupJid) {
    try {
      await sendToWhatsApp(payload)
      lastSentRadarState = status
      infoLog(`✅ Service message sent for state='${status}'`)
      return true
    } catch (e) {
      warnLog('⚠️ Failed to send service message now: ' + (e?.message || e))
      pendingServiceMessage = status
      return false
    }
  } else {
    warnLog(`WA not connected or group unknown — scheduling service message for '${status}' when connected.`)
    pendingServiceMessage = status
    return false
  }
}

// send text to WA group
export async function sendToWhatsApp(text) {
  try {
    if (!sock || waConnectionStatus !== 'connected') { warnLog('⏳ WA не готов — сообщение не отправлено'); return false }
    const jid = cachedGroupJid || (process.env.WA_GROUP_ID ? (process.env.WA_GROUP_ID.endsWith('@g.us') ? process.env.WA_GROUP_ID : process.env.WA_GROUP_ID + '@g.us') : null)
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

// small getters for routes
export function getWaStatus() {
  return {
    whatsapp: waConnectionStatus,
    qrPending: !!lastQR,
    waGroup: cachedGroupJid ? { id: cachedGroupJid } : null,
    configuredGroupId: process.env.WA_GROUP_ID || null,
    configuredGroupName: process.env.WA_GROUP_NAME || process.env.WHATSAPP_GROUP_NAME || null,
    radarActive: !!radarActive,
    lastSentRadarState: lastSentRadarState || null
  }
}

export function getRecentForwarded() {
  return recentForwarded.slice().reverse()
}

export function getRecentWAMessages() {
  return recentWAMessages.slice().reverse()
}

// API to toggle radar
export async function setRadar(on) {
  radarActive = !!on
  infoLog(`Radar set to ${radarActive ? 'ON' : 'OFF'}`)
  if (radarActive) {
    try { startWhatsApp({ reset: false }).catch(()=>{}) } catch(e){}
    await sendServiceMessage('on').catch(()=>{})
  } else {
    await sendServiceMessage('off').catch(()=>{})
  }
}

// helper to produce QR pages for routes
export async function qrDataUrl() {
  if (!lastQR) return null
  try {
    const dataUrl = await QRCode.toDataURL(lastQR, { margin: 1, width: 640 })
    return dataUrl
  } catch (e) { return null }
}
