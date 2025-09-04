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
import chalk from 'chalk'

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
let waConnectionStatus = 'disconnected'
let telegramConnected = false

// ---------------- Express ----------------
const app = express()
app.use(express.json())
app.get('/ping', (req, res) => res.send('pong'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))
app.get('/', (req, res) => res.send('🤖 Telegram → WhatsApp мост работает'))

app.post('/wa/reset', async (req, res) => {
  try {
    console.log(chalk.yellow('🚨 Ручной сброс сессии WhatsApp через /wa/reset'))
    await startWhatsApp({ reset: true })
    res.send({ status: 'ok', message: 'WhatsApp сессия сброшена и начата новая авторизация' })
  } catch (err) {
    console.error(chalk.red('❌ Ошибка при ручном сбросе сессии:'), err)
    res.status(500).send({ status: 'error', message: err.message })
  }
})

app.get('/wa/status', (req, res) => {
  res.send({
    whatsapp: waConnectionStatus,
    telegram: telegramConnected,
    waGroup: waGroupJid ? { id: waGroupJid, name: WHATSAPP_GROUP_NAME } : null,
    qrPending: !!lastQR
  })
})

app.listen(Number(PORT), () => console.log(chalk.cyan(`🌐 HTTP сервер на порту ${PORT}`)))

// ---------------- Telegram ----------------
console.log(chalk.cyan('🔹 Проверка окружения:'))
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

async function sendTelegramNotification(text) {
  if (!telegramConnected) return
  try {
    await tgClient.sendMessage(TG_SOURCE, { message: text })
    console.log(chalk.green('📨 Уведомление отправлено в Telegram:'), text)
  } catch (e) {
    console.error(chalk.red('⚠️ Не удалось отправить уведомление в Telegram:'), e)
  }
}

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
        console.log(chalk.cyan('📩 Новое сообщение из Telegram:'), text)
        await sendToWhatsApp(text)
      }
    }
  } catch (e) {
    console.error(chalk.red('⚠️ Ошибка обработки события Telegram:'), e)
  }
}, new NewMessage({}))

async function initTelegram() {
  console.log(chalk.cyan('🚀 Запуск Telegram...'))
  await tgClient.connect()
  telegramConnected = true
  console.log(chalk.green('✅ Telegram клиент запущен'))
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
    console.error(chalk.red('⚠️ Не удалось удалить каталог авторизации:'), e)
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
    console.log(chalk.green('💾 Сессия WhatsApp сохранена в Gist (перезаписана)'))
  } catch (e) {
    console.error(chalk.red('❌ Ошибка сохранения сессии в Gist:'), e)
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
      console.log(chalk.yellow('⚠️ Сессия из Gist не найдена'))
      return false
    }
    ensureDir(AUTH_DIR)
    for (const name in data.files) {
      const content = data.files[name].content
      fs.writeFileSync(path.join(AUTH_DIR, name), content, 'utf-8')
    }
    console.log(chalk.green('📥 Сессия WhatsApp загружена из Gist'))
    return true
  } catch (e) {
    console.error(chalk.red('❌ Ошибка загрузки сессии из Gist:'), e)
    return false
  }
}

// ---------------- WhatsApp ----------------
async function startWhatsApp({ reset = false } = {}) {
  if (reset) {
    console.log(chalk.yellow('♻️ Сброс авторизации WhatsApp — удаляю'), AUTH_DIR)
    rmDirSafe(AUTH_DIR)
    if (sock) {
      try { await sock.logout() } catch {}
      try { sock.end && sock.end() } catch {}
      sock = null
    }
    sessionLoaded = false
    waConnectionStatus = 'disconnected'
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
    const statusColor = {
      connected: chalk.green,
      awaiting_qr: chalk.yellow,
      disconnected: chalk.red
    }

    console.log('====================[ WA STATUS CHECKLIST ]====================')
    console.log(statusColor[waConnectionStatus](`🟢 WhatsApp: ${waConnectionStatus}`))
    console.log(chalk.cyan(`🔹 Telegram: ${telegramConnected ? 'connected' : 'disconnected'}`))
    console.log(chalk.yellow(`🔸 QR pending: ${!!lastQR}`))
    console.log(chalk.magenta(`🔹 Target group: ${waGroupJid || 'не найдено'}`))
    console.log('================================================================')

    if (qr && !sessionLoaded) {
      lastQR = qr
      console.log(chalk.yellow('📱 Новый QR получен!'))
      qrcodeTerminal.generate(qr, { small: true })
      console.log(chalk.yellow(`🌍 Откройте QR в браузере: ${DOMAIN}/wa/qr`))
      waConnectionStatus = 'awaiting_qr'
      await sendTelegramNotification('⚠️ Новый QR для WhatsApp! Требуется авторизация.')
    }

    if (connection === 'open') {
      console.log(chalk.green('✅ WhatsApp подключён'))
      waConnectionStatus = 'connected'
      sessionLoaded = true
      await cacheGroupJid()
      if (waGroupJid) {
        const startupMsg = '🔧сервисное сообщение🔧\n[Подключение установлено, РАДАР АКТИВЕН 🌎]'
        await sendToWhatsApp(startupMsg)
      }
      await sendTelegramNotification('✅ WhatsApp успешно подключён.')
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error
      console.log(chalk.red('❌ WhatsApp отключён'), err ? `(${err?.message || err})` : '')
      waConnectionStatus = 'disconnected'
      await sendTelegramNotification(`❌ WhatsApp отключён ${err ? `(${err.message || err})` : ''}`)

      if (!triedReset && err && (/auth/i.test(err.message || '') || /QR refs attempts ended/i.test(err.message || ''))) {
        console.log(chalk.yellow('⚠️ Сессия WhatsApp невалидна или была отвязана вручную, создаём новую...'))
        triedReset = true
        await startWhatsApp({ reset: true })
        return
      }

      console.log(chalk.yellow('⏳ Переподключение через 5 секунд...'))
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
      console.log(chalk.green(`✅ Найдена группа WhatsApp: ${target.subject} (${waGroupJid})`))
    } else {
      console.log(chalk.red(`❌ Группа WhatsApp "${WHATSAPP_GROUP_NAME}" не найдена`))
      await sendTelegramNotification(`❌ Группа WhatsApp "${WHATSAPP_GROUP_NAME}" не найдена`)
    }
  } catch (e) {
    console.error(chalk.red('❌ Ошибка получения списка групп:'), e)
    await sendTelegramNotification(`❌ Ошибка получения списка групп WhatsApp: ${e.message || e}`)
  }
}

async function sendToWhatsApp(text) {
  if (!sock) {
    console.log(chalk.yellow('⏳ Нет активного соединения с WhatsApp'))
    await sendTelegramNotification('⚠️ Попытка отправки сообщения в WhatsApp, но соединение отсутствует.')
    return
  }
  if (!waGroupJid) await cacheGroupJid()
  if (!waGroupJid) {
    await sendTelegramNotification('⚠️ Сообщение не отправлено: группа WhatsApp не найдена.')
    return
  }

  try {
    await sock.sendMessage(waGroupJid, { text })
    console.log(chalk.green('➡️ Сообщение переслано в WhatsApp'))
  } catch (err) {
    console.error(chalk.red('❌ Ошибка отправки в WhatsApp:'), err)
    await sendTelegramNotification(`❌ Ошибка отправки сообщения в WhatsApp: ${err.message || err}`)
  }
}

// ---------------- Старт ----------------
;(async () => {
  try {
    console.log(chalk.cyan('🚀 Старт моста Telegram → WhatsApp...'))
    await initTelegram()
    await startWhatsApp()
    console.log(chalk.green('✅ Мост запущен и работает'))
  } catch (err) {
    console.error(chalk.red('❌ Ошибка запуска:'), err)
    process.exit(1)
  }
})()

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
