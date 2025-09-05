import 'dotenv/config'
import express from 'express'
import makeWASocket, { useMultiFileAuthState, Browsers, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import QRCode from 'qrcode'
import fs from 'fs'
import axios from 'axios'
import chalk from 'chalk'
import P from 'pino'

// ---------------- Конфиг ----------------
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TG_SOURCE,
  WA_GROUP_ID,
  PORT = 3000,
  GITHUB_TOKEN,
  GIST_ID,
} = process.env

// ---------------- Telegram ----------------
let tgClient

async function startTelegram() {
  console.log(chalk.green('🚀 Запуск Telegram...'))
  tgClient = new TelegramClient(
    new StringSession(TELEGRAM_STRING_SESSION),
    parseInt(TELEGRAM_API_ID),
    TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  )
  await tgClient.start()
  console.log(chalk.green('✅ Telegram подключен'))

  tgClient.addEventHandler(async (event) => {
    const sender = await event.message.getSender()
    const senderIdStr = sender?.id?.toString()
    const senderUsername = sender?.username?.toLowerCase()

    const isFromSource =
      TG_SOURCE &&
      (
        senderUsername === TG_SOURCE ||
        senderIdStr === TG_SOURCE ||
        ('-' + senderIdStr) === TG_SOURCE
      )

    if (isFromSource && event.message.message) {
      console.log(chalk.blue('📩 Из Telegram:'), event.message.message)
      await sendToWhatsApp(event.message.message)
    }
  }, new NewMessage({}))
}

// ---------------- WhatsApp ----------------
let sock
let lastQR = null
let isStartingWA = false
let saveAuthTimer = null

async function loadAuthFromGist() {
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    })
    const files = res.data.files
    if (!files) return false

    if (!fs.existsSync('./auth_info_baileys')) fs.mkdirSync('./auth_info_baileys')

    for (const file of Object.values(files)) {
      fs.writeFileSync(`./auth_info_baileys/${file.filename}`, file.content)
    }
    return true
  } catch (err) {
    console.log('⚠️ Не удалось загрузить auth из Gist:', err.message)
    return false
  }
}

function debounceSaveAuth() {
  if (saveAuthTimer) clearTimeout(saveAuthTimer)
  saveAuthTimer = setTimeout(saveAuthToGist, 3000)
}

async function saveAuthToGist() {
  try {
    if (!fs.existsSync('./auth_info_baileys')) return
    const files = {}
    for (const file of fs.readdirSync('./auth_info_baileys')) {
      files[file] = { content: fs.readFileSync(`./auth_info_baileys/${file}`, 'utf-8') }
    }
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      { files },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    )
    console.log('✅ Auth сохранён в Gist')
  } catch (err) {
    console.log('⚠️ Ошибка при сохранении auth в Gist:', err.message)
  }
}

async function startWhatsApp({ reset = false } = {}) {
  if (isStartingWA) return
  isStartingWA = true
  console.log(chalk.green('🚀 Запуск WhatsApp...'))

  if (reset && fs.existsSync('./auth_info_baileys')) {
    fs.rmSync('./auth_info_baileys', { recursive: true, force: true })
  }

  const loaded = await loadAuthFromGist()
  if (!loaded) console.log('⚠️ Сессия не найдена, будет нужна авторизация через QR')

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'warn' })) },
    logger: P({ level: 'warn' }),
    browser: Browsers.appropriate('Chrome'),
    printQRInTerminal: false,
  })

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    debounceSaveAuth()
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr
      console.log(chalk.yellow('📱 Новый QR доступен в WebUI /qr'))
    }
    if (connection === 'open') {
      console.log(chalk.green('✅ WhatsApp подключен'))
      sendWelcome()
      lastQR = null
      isStartingWA = false
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      console.log('⚠️ WhatsApp соединение закрыто', statusCode)
      isStartingWA = false
      if (statusCode === 401) startWhatsApp({ reset: true })
      else if (statusCode !== 409) setTimeout(() => startWhatsApp({ reset: false }), 5000)
    }
  })
}

async function sendToWhatsApp(text) {
  if (!sock || !sock.user) return console.log(chalk.red('❌ Нет подключения к WhatsApp'))
  await sock.sendMessage(WA_GROUP_ID + '@g.us', { text })
}

async function sendWelcome() {
  try {
    await sock.sendMessage(WA_GROUP_ID + '@g.us', { text: '✅ Бот подключен к группе' })
  } catch (err) {
    console.log('⚠️ Не удалось отправить welcome:', err.message)
  }
}

// ---------------- Web UI ----------------
const app = express()

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>TG ⇄ WA Bridge</title>
        <style>
          body { font-family: sans-serif; padding: 20px; text-align: center; }
          button { margin: 5px; padding: 10px 15px; font-size: 16px; }
          img { max-width: 300px; }
        </style>
      </head>
      <body>
        <h1>🌉 TG ⇄ WA Bridge</h1>
        <button onclick="location.href='/reset-wa'">♻️ Сбросить WA-сессию</button>
        <button onclick="location.href='/status'">ℹ️ Статус</button>
        <button onclick="location.href='/send-test'">📤 Тест-сообщение</button>
        <h2>📱 QR-код WhatsApp</h2>
        <div id="qr-container"><p>Ждём генерацию QR...</p></div>
        <script>
          async function updateQR() {
            const res = await fetch('/qr-data')
            const data = await res.json()
            const container = document.getElementById('qr-container')
            if (data.qr) container.innerHTML = '<img src="' + data.qr + '" /><p>QR обновляется каждые 5 секунд</p>'
            else container.innerHTML = '<p>QR пока не сгенерирован, подожди...</p>'
          }
          setInterval(updateQR, 5000)
          updateQR()
        </script>
      </body>
    </html>
  `)
})

app.get('/qr-data', async (req, res) => {
  if (!lastQR) return res.json({ qr: null })
  try {
    const qrDataUrl = await QRCode.toDataURL(lastQR)
    res.json({ qr: qrDataUrl })
  } catch {
    res.json({ qr: null })
  }
})

app.get('/reset-wa', async (req, res) => {
  if (sock) await sock.logout()
  res.send('♻️ WA-сессия сброшена, жди новый QR в WebUI')
})

app.get('/status', (req, res) => {
  res.json({
    telegram: tgClient?.connected ? 'online' : 'offline',
    whatsapp: sock?.user ? 'online' : (lastQR ? 'awaiting_qr' : 'offline'),
  })
})

app.get('/send-test', async (req, res) => {
  await sendToWhatsApp('📤 Тестовое сообщение')
  res.send('✅ Тестовое сообщение отправлено')
})

// ---------------- Запуск ----------------
;(async () => {
  await startTelegram()
  await startWhatsApp()
  app.listen(PORT, () => console.log(`🌐 WebUI: http://localhost:${PORT}`))
})()

// ---------------- Graceful shutdown ----------------
process.on('SIGINT', async () => {
  console.log('👋 Завершаем...')
  try { await sock?.end?.(); await tgClient?.disconnect?.() } catch {}
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('👋 Завершаем...')
  try { await sock?.end?.(); await tgClient?.disconnect?.() } catch {}
  process.exit(0)
})
