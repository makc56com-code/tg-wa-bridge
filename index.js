import 'dotenv/config'
import express from 'express'
import makeWASocket, { useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import qrcode from 'qrcode-terminal'

// ---------------- Конфиг ----------------
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TELEGRAM_SOURCE,
  WHATSAPP_GROUP_NAME,
  ADMIN_TOKEN,
  PORT = 3000,
} = process.env

let sock = null
let waGroupJid = null

// ---------------- Telegram ----------------
const tgClient = new TelegramClient(
  new StringSession(TELEGRAM_STRING_SESSION),
  Number(TELEGRAM_API_ID),
  TELEGRAM_API_HASH,
  { connectionRetries: 5 }
)

tgClient.addEventHandler(async (event) => {
  const message = event.message
  const sender = await message.getSender()

  if (
    sender &&
    (sender.username === TELEGRAM_SOURCE ||
      sender.firstName === TELEGRAM_SOURCE ||
      sender.id.toString() === TELEGRAM_SOURCE)
  ) {
    console.log('📩 Новое сообщение из Telegram:', message.message)
    await sendToWhatsApp(message.message)
  }
}, new NewMessage({}))

async function initTelegram() {
  console.log('🚀 Запуск Telegram...')
  await tgClient.connect()
  console.log('✅ Telegram клиент запущен')
  console.log('👤 Источник сообщений:', TELEGRAM_SOURCE)
}

// ---------------- WhatsApp (Baileys) ----------------
async function startWhatsApp({ reset = false } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: Browsers.appropriate('Render', 'Chrome'),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log('📱 Отсканируйте QR для WhatsApp:')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp подключён')
      cacheGroupJid()
    }
    if (connection === 'close') {
      console.log('❌ WhatsApp отключён, пробую переподключиться...')
      startWhatsApp()
    }
  })

  if (reset) {
    console.log('♻️ Сброс авторизации WhatsApp — ждите новый QR...')
  }
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
  if (!sock) {
    console.log('⏳ Нет активного соединения с WhatsApp')
    return
  }
  if (!waGroupJid) await cacheGroupJid()
  if (waGroupJid) {
    await sock.sendMessage(waGroupJid, { text })
    console.log('➡️ Сообщение переслано в WhatsApp')
  } else {
    console.log('⚠️ Группа WhatsApp не найдена, сообщение не переслано')
  }
}

// ---------------- Express (Render + админ) ----------------
const app = express()
app.use(express.json())

app.get('/', (req, res) => res.send('🤖 Telegram → WhatsApp (Baileys) мост работает'))

app.post('/wa/relogin', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token']
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(403).send('forbidden')
  await startWhatsApp({ reset: true })
  res.send('OK: relogin started — смотрите логи для QR')
})

app.listen(Number(PORT), () => console.log(`🌐 HTTP сервер на порту ${PORT}`))

// ---------------- Старт ----------------
;(async () => {
  try {
    await initTelegram()
    await startWhatsApp()
  } catch (err) {
    console.error('❌ Ошибка запуска:', err)
  }
})()

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
