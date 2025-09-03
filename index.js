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
let currentQR = null
let lastQR = null // для отслеживания изменений QR

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
    (String(sender.id) === TELEGRAM_SOURCE ||
      sender.username === TELEGRAM_SOURCE ||
      sender.firstName === TELEGRAM_SOURCE)
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
    browser: Browsers.appropriate('Render', 'Chrome'),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update

    console.log('🔄 connection.update:', update)

    if (qr) {
      if (qr !== lastQR) {
        console.log('📱 Новый QR получен')
        currentQR = qr
        lastQR = qr
        qrcode.generate(qr, { small: true }) // локальный ASCII
        console.log(`🔗 Ссылка на веб-QR: https://tg-wa-bridge.onrender.com/wa/qr`)
      }
    } else {
      if (lastQR) {
        console.log('✅ WhatsApp подключён, QR больше не нужен')
        lastQR = null
        currentQR = null
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp подключён')
      cacheGroupJid()
    }

    if (connection === 'close') {
      console.log('❌ WhatsApp отключён, переподключение через 5 секунд...')
      setTimeout(startWhatsApp, 5000)
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

// ---------------- Express (Render + админ) ----------------
const app = express()
app.use(express.json())

app.get('/', (req, res) => res.send('🤖 Telegram → WhatsApp (Baileys) мост работает'))

// страница с динамическим QR
app.get('/wa/qr', (req, res) => {
  res.send(`
    <h2>📱 QR для WhatsApp</h2>
    <div id="qr">
      <p>Ждём генерации QR...</p>
    </div>
    <p>QR обновляется автоматически каждые 5 секунд</p>
    <script>
      async function fetchQR() {
        try {
          const r = await fetch('/wa/qr/json')
          const data = await r.json()
          const qrDiv = document.getElementById('qr')
          if (data.qr) {
            qrDiv.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(data.qr) + '&size=300x300" />'
          } else {
            qrDiv.innerHTML = '<p>WhatsApp уже подключён!</p>'
          }
        } catch (err) {
          console.error(err)
        }
      }
      setInterval(fetchQR, 5000)
      fetchQR()
    </script>
  `)
})

// JSON-эндпоинт для актуального QR
app.get('/wa/qr/json', (req, res) => {
  res.json({ qr: currentQR || null })
})

// ручной релогин
app.post('/wa/relogin', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token']
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(403).send('forbidden')
  await startWhatsApp({ reset: true })
  res.send('OK: relogin started — смотрите логи для QR')
})

app.listen(Number(PORT), () => {
  console.log(`🌐 HTTP сервер на порту ${PORT}`)
  console.log(`📱 QR для WhatsApp доступен по ссылке: https://tg-wa-bridge.onrender.com/wa/qr`)
})

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
