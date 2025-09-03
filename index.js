import 'dotenv/config'
import express from 'express'
import makeWASocket, { useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import url from 'url'

// ---------------- Конфиг ----------------
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TELEGRAM_SOURCE,
  WHATSAPP_GROUP_NAME,
  ADMIN_TOKEN,
  PORT = process.env.PORT || 3000,
  AUTH_DIR = process.env.AUTH_DIR || 'auth_info',
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

// нормализуем «источник» из .env (убираем @, пробелы)
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

    // Сравниваем по нескольким признакам
    const senderIdStr = sender?.id ? String(sender.id) : ''
    const senderUsername = sender?.username ? String(sender.username).toLowerCase() : ''
    const senderFirst = sender?.firstName ? String(sender.firstName).toLowerCase() : ''

    const isFromSource =
      (!!TG_SOURCE && (
        senderIdStr === TG_SOURCE ||                  // если в .env указан числовой id
        senderUsername === TG_SOURCE ||               // @username (без @)
        senderFirst === TG_SOURCE                     // имя
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

// ---------------- Утилиты для AUTH_DIR ----------------
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

// ---------------- WhatsApp (Baileys) ----------------
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

  ensureDir(AUTH_DIR)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate('Render', 'Chrome'),
    // печать встроенного QR не включаем — сами обрабатываем событие
    // printQRInTerminal: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      if (qr !== lastQR) {
        currentQR = qr
        lastQR = qr
        console.log('📱 Новый QR получен (также доступен на странице /wa/qr)')
        // ASCII в логи (на случай локального запуска)
        qrcodeTerminal.generate(qr, { small: true })
      }
    } else if (lastQR) {
      console.log('✅ WhatsApp подключён, QR больше не нужен')
      currentQR = null
      lastQR = null
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp подключён')
      cacheGroupJid()
    } else if (connection === 'close') {
      const err = lastDisconnect?.error
      console.log('❌ WhatsApp отключён', err ? `(${err?.message || err})` : '')
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

// ---------------- Express (Render + админ) ----------------
const app = express()
app.use(express.json())

// 🔹 Новый ping-эндпоинт для UptimeRobot
app.get('/ping', (req, res) => {
  res.send('pong')
})

app.get('/healthz', (req, res) => res.status(200).send('ok'))
app.get('/', (req, res) => res.send('🤖 Telegram → WhatsApp (Baileys) мост работает'))

// Страница с живым QR (SVG генерируется локально, без внешних сервисов)
app.get('/wa/qr', async (req, res) => {
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
  const html = `
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>QR для WhatsApp</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    .wrap { max-width: 520px; margin: 0 auto; text-align: center; }
    #qrbox { margin-top: 16px; }
    .muted { color: #666; font-size: 14px; }
    .badge { display:inline-block; padding:4px 8px; border:1px solid #ddd; border-radius:999px; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>📱 QR для WhatsApp</h2>
    <div class="badge">Обновляется каждые ~20 сек</div>
    <div id="qrbox"><p class="muted">Ждём генерации QR...</p></div>
    <p class="muted">Если QR пропал — соединение установлено или код устарел, страница обновится автоматически.</p>
  </div>
  <script>
    let last = ''
    async function draw() {
      try {
        const r = await fetch('/wa/qr/json', { cache: 'no-store' })
        const data = await r.json()
        const box = document.getElementById('qrbox')
        if (data.qr && data.qr !== last) {
          last = data.qr
          const r2 = await fetch('/wa/qr/svg?data=' + encodeURIComponent(data.qr), { cache: 'no-store' })
          const svg = await r2.text()
          box.innerHTML = svg
        } else if (!data.qr) {
          box.innerHTML = '<p class="muted">WhatsApp уже подключён</p>'
        }
      } catch (e) {
        console.error(e)
      }
    }
    setInterval(draw, 5000)
    draw()
  </script>
</body>
</html>
  `
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.send(html)
})

// JSON-эндпоинт для актуального QR
app.get('/wa/qr/json', (req, res) => {
  res.json({ qr: currentQR || null })
})

// SVG-эндпоинт (генерируем локально, без внешних API)
app.get('/wa/qr/svg', async (req, res) => {
  const data = req.query.data
  if (!data) return res.status(400).send('missing data')
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, width: 320 })
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
    res.send(svg)
  } catch (e) {
    res.status(500).send('qr error')
  }
})

// ручной релогин (полный сброс AUTH_DIR)
app.post('/wa/relogin', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token']
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(403).send('forbidden')
  await startWhatsApp({ reset: true })
  res.send('OK: relogin started — смотрите логи для QR')
})

app.listen(Number(PORT), () => {
  console.log(`🌐 HTTP сервер на порту ${PORT}`)
  console.log(`📱 Страница с QR: /wa/qr (относительный путь; домен берите из Render)`)
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
