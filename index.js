import 'dotenv/config'
import express from 'express'
import makeWASocket, { useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import fs from 'fs'
import axios from 'axios'
import chalk from 'chalk'
import { Boom } from '@hapi/boom'

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

async function loadAuthFromGist() {
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    })
    const files = res.data.files
    if (!files) return null

    if (!fs.existsSync('./auth_info_baileys')) {
      fs.mkdirSync('./auth_info_baileys')
    }

    for (const file of Object.values(files)) {
      fs.writeFileSync(`./auth_info_baileys/${file.filename}`, file.content)
    }
    return true
  } catch (err) {
    console.log('⚠️ Не удалось загрузить auth из Gist:', err.message)
    return null
  }
}

async function saveAuthToGist() {
  try {
    const files = {}
    const authFiles = fs.readdirSync('./auth_info_baileys')
    for (const file of authFiles) {
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
  console.log(chalk.green('🚀 Запуск WhatsApp...'))

  if (reset && fs.existsSync('./auth_info_baileys')) {
    fs.rmSync('./auth_info_baileys', { recursive: true, force: true })
  }

  await loadAuthFromGist()

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

  sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate('Chrome'),
    printQRInTerminal: true,
  })

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    await saveAuthToGist()
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr
      console.clear()
      qrcode.generate(qr, { small: true })
      console.log(chalk.yellow('📱 Новый QR доступен и на WebUI /qr'))
    }
    if (connection === 'open') {
      console.log(chalk.green('✅ WhatsApp подключен'))
      sendWelcome()
      lastQR = null
    }
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('⚠️ WhatsApp соединение закрыто', statusCode)
      if (statusCode !== 401) {
        setTimeout(() => startWhatsApp({ reset: false }), 5000)
      }
    }
  })

  // QR автообновление
  setInterval(() => {
    if (sock?.user === undefined) {
      console.log(chalk.yellow('♻️ Обновление QR...'))
      sock.logout()
    }
  }, 60000)
}

async function sendToWhatsApp(text) {
  if (!sock || !sock.user) {
    console.log(chalk.red('❌ Нет подключения к WhatsApp'))
    return
  }
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
          body { font-family: sans-serif; padding: 20px; }
          button { margin: 5px; padding: 10px 15px; font-size: 16px; }
        </style>
      </head>
      <body>
        <h1>🌉 TG ⇄ WA Bridge</h1>
        <button onclick="location.href='/reset-wa'">♻️ Сбросить WA-сессию</button>
        <button onclick="location.href='/status'">ℹ️ Статус</button>
        <button onclick="location.href='/send-test'">📤 Тест-сообщение</button>
        <button onclick="location.href='/qr'">📱 QR-код</button>
      </body>
    </html>
  `)
})

app.get('/reset-wa', async (req, res) => {
  if (sock) await sock.logout()
  res.send('♻️ WA-сессия сброшена, жди новый QR в консоли и на /qr')
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

app.get('/qr', async (req, res) => {
  if (!lastQR) {
    return res.send('⚠️ QR пока не сгенерирован (подожди)')
  }
  const qrDataUrl = await QRCode.toDataURL(lastQR)
  res.send(`
    <html>
      <head><title>WhatsApp QR</title></head>
      <body style="font-family: sans-serif; text-align: center;">
        <h2>📱 Отсканируй QR WhatsApp</h2>
        <img src="${qrDataUrl}" />
        <p>Эта страница обновляется каждые 5 секунд</p>
        <script>
          setTimeout(() => location.reload(), 5000)
        </script>
      </body>
    </html>
  `)
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
  try {
    await sock?.end?.()
    await tgClient?.disconnect?.()
  } catch {}
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('👋 Завершаем...')
  try {
    await sock?.end?.()
    await tgClient?.disconnect?.()
  } catch {}
  process.exit(0)
})
