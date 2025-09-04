import 'dotenv/config'
import express from 'express'
import makeWASocket, { useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import qrcodeTerminal from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'
import fetch from 'node-fetch'

const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TELEGRAM_SOURCE,
  WHATSAPP_GROUP_NAME,
  PORT = 3000,
  AUTH_DIR = 'auth_info',
  GITHUB_TOKEN,
  GIST_ID
} = process.env

let sock = null
let waGroupJid = null
let lastQR = null
let sessionLoaded = false

// ---------------- Express ----------------
const app = express()
app.use(express.json())
app.get('/ping', (req, res) => res.send('pong'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))
app.get('/', (req, res) => res.send('🤖 Telegram → WhatsApp мост работает'))
app.listen(Number(PORT), () => console.log(`🌐 HTTP сервер на порту ${PORT}`))

// ---------------- Telegram ----------------
console.log('🔹 Проверка окружения:')
console.log('TELEGRAM_API_ID:', !!TELEGRAM_API_ID)
console.log('TELEGRAM_API_HASH:', !!TELEGRAM_API_HASH)
console.log('TELEGRAM_STRING_SESSION:', !!TELEGRAM_STRING_SESSION)
console.log('GITHUB_TOKEN:', !!GITHUB_TOKEN)
console.log('GIST_ID:', !!GIST_ID)
console.log('WHATSAPP_GROUP_NAME:', !!WHATSAPP_GROUP_NAME)

const tgClient = new TelegramClient(
  new StringSession(TELEGRAM_STRING_SESSION),
  Number(TELEGRAM_API_ID),
  TELEGRAM_API_HASH,
  { connectionRetries: 5 }
)

function normSource(v) {
  if (!v) return ''
  return String(v).trim().replace(/^@/, '').toLowerCase()
}
const TG_SOURCE = normSource(TELEGRAM_SOURCE)

tgClient.addEventHandler(async (event) => {
  const message = event.message
  if (!message) return
  try {
    const sender = await message.getSender()
    const senderIdStr = sender?.id ? String(sender.id) : ''
    const senderUsername = sender?.username ? String(sender.username).toLowerCase() : ''
    const senderFirst = sender?.firstName ? String(sender.firstName).toLowerCase() : ''

    const isFromSource =
      (!!TG_SOURCE && (
        senderIdStr === TG_SOURCE ||
        senderUsername === TG_SOURCE ||
        senderFirst === TG_SOURCE
      ))

    if (isFromSource) {
      const text = message.message || ''
      if (text.trim().length > 0) {
        console.log('📩 Новое сообщение из Telegram:', text)
        await sendToWhatsApp(text)
      }
    }
  } catch (e) {
    console.error('⚠️ Ошибка обработки события Telegram:', e)
  }
}, new NewMessage({}))

async function initTelegram() {
  console.log('🚀 Запуск Telegram...')
  await tgClient.connect()
  console.log('✅ Telegram клиент запущен')
  console.log('👤 Источник сообщений:', TELEGRAM_SOURCE)
}

// ---------------- Утилиты ----------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function rmDirSafe(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error('⚠️ Не удалось удалить каталог авторизации:', e)
  }
}

// ---------------- GitHub Gist ----------------
async function saveSessionToGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return
  try {
    const files = {}
    const authFiles = fs.readdirSync(AUTH_DIR)
    for (const f of authFiles) {
      const content = fs.readFileSync(path.join(AUTH_DIR, f), 'utf-8')
      files[f] = { content }
    }
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ files })
    })
    console.log('💾 Сессия WhatsApp сохранена в Gist (перезаписана)')
  } catch (e) {
    console.error('❌ Ошибка сохранения сессии в Gist:', e)
  }
}

async function loadSessionFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return false
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    })
    const data = await res.json()
    if (!data.files) {
      console.log('⚠️ Сессия из Gist не найдена')
      return false
    }
    ensureDir(AUTH_DIR)
    for (const name in data.files) {
      const content = data.files[name].content
      fs.writeFileSync(path.join(AUTH_DIR, name), content, 'utf-8')
    }
    console.log('📥 Сессия WhatsApp загружена из Gist')
    return true
  } catch (e) {
    console.error('❌ Ошибка загрузки сессии из Gist:', e)
    return false
  }
}

// ---------------- WhatsApp ----------------
async function startWhatsApp({ reset = false } = {}) {
  if (reset) {
    console.log('♻️ Сброс авторизации WhatsApp — удаляю', AUTH_DIR)
    rmDirSafe(AUTH_DIR)
    if (sock) {
      try { await sock.logout() } catch {}
      try { sock.end && sock.end() } catch {}
      sock = null
    }
  }

  sessionLoaded = await loadSessionFromGist()
  ensureDir(AUTH_DIR)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate('Render', 'Chrome')
  })

  const DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`
  let triedReset = false

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    await saveSessionToGist()
  })

  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr && !sessionLoaded) {
      if (qr !== lastQR) {
        lastQR = qr
        console.log('📱 Новый QR получен!')
        qrcodeTerminal.generate(qr, { small: true })
        console.log(`🌍 Откройте QR в браузере: ${DOMAIN}/wa/qr`)
      }
    } else if (lastQR) {
      console.log('✅ WhatsApp подключён, QR больше не нужен')
      lastQR = null
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp подключён')
      await cacheGroupJid()
      if (waGroupJid) {
        const startupMsg = '🔧сервисное сообщение🔧\n[Подключение установлено, РАДАР АКТИВЕН 🌎]'
        await sendToWhatsApp(startupMsg)
      }
    } else if (connection === 'close') {
      const err = lastDisconnect?.error
      console.log('❌ WhatsApp отключён', err ? `(${err?.message || err})` : '')

      if (!triedReset && err && /auth/i.test(err.message || '')) {
        console.log('⚠️ Сессия невалидна, создаём новую...')
        triedReset = true
        await startWhatsApp({ reset: true })
        return
      }

      console.log('⏳ Переподключение через 5 секунд...')
      setTimeout(() => startWhatsApp({ reset: false }), 5000)
    }
  })
}

async function cacheGroupJid() {
  try {
    const groups = await sock.groupFetchAllParticipating()
    const target = Object.values(groups).find(
      (g) =>
        (g.subject || '').trim().toLowerCase() ===
        (WHATSAPP_GROUP_NAME || '').trim().toLowerCase()
    )
    if (target) {
      waGroupJid = target.id
      console.log(`✅ Найдена группа WhatsApp: ${target.subject} (${waGroupJid})`)
    } else {
      console.log(`❌ Группа WhatsApp "${WHATSAPP_GROUP_NAME}" не найдена`)
    }
  } catch (e) {
    console.error('❌ Ошибка получения списка групп:', e)
  }
}

async function sendToWhatsApp(text) {
  if (!sock) return console.log('⏳ Нет активного соединения с WhatsApp')
  if (!waGroupJid) await cacheGroupJid()
  if (!waGroupJid) return console.log('⚠️ Группа WhatsApp не найдена, сообщение не переслано')

  try {
    await sock.sendMessage(waGroupJid, { text })
    console.log('➡️ Сообщение переслано в WhatsApp')
  } catch (err) {
    console.error('❌ Ошибка отправки в WhatsApp:', err)
  }
}

// ---------------- Старт ----------------
;(async () => {
  try {
    console.log('🚀 Старт моста Telegram → WhatsApp...')
    await initTelegram()
    await startWhatsApp()
    console.log('✅ Мост запущен и работает')
  } catch (err) {
    console.error('❌ Ошибка запуска:', err)
    process.exit(1)
  }
})()

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
