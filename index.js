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
let qrTimer = null

const TG_SOURCE = TELEGRAM_SOURCE ? TELEGRAM_SOURCE.replace(/^@/, '').toLowerCase() : ''

// ---------------- Express ----------------
const app = express()
app.use(express.json())
const DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`

app.get('/ping', (req, res) => res.send('pong'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))
app.get('/', (req, res) => res.send('🤖 Telegram → WhatsApp мост работает'))

app.get('/wa/status', (req, res) => res.send({
  whatsapp: waConnectionStatus,
  telegram: telegramConnected,
  waGroup: waGroupJid ? { id: waGroupJid, name: WHATSAPP_GROUP_NAME } : null,
  qrPending: !!lastQR
}))

app.post('/wa/reset', async (req, res) => {
  console.log(chalk.yellow('🚨 Ручной сброс сессии WhatsApp через /wa/reset'))
  await startWhatsApp({ reset: true })
  res.send({ status: 'ok', message: 'WhatsApp сессия сброшена и начата новая авторизация' })
})

app.get('/wa/qr', (req,res)=>{
  if(!lastQR) return res.status(404).send('QR код пока не сгенерирован')
  import('qrcode').then(QRCode=>{
    QRCode.toDataURL(lastQR).then(url=>{
      console.log(chalk.yellow('🌍 QR URL для WhatsApp: '), DOMAIN+'/wa/qr')
      res.send(`<img src="${url}"/>`)
    }).catch(e=>res.status(500).send(e))
  })
})

app.get('/wa/qr-ascii', (req,res)=>{
  if(!lastQR) return res.status(404).send('QR код пока не сгенерирован')
  qrcodeTerminal.generate(lastQR,{small:true}, qrcode=>{
    console.log(chalk.yellow('🌍 QR ASCII для WhatsApp:')); console.log(qrcode)
    res.setHeader('Content-Type','text/plain')
    res.send(qrcode)
  })
})

app.post('/wa/send', async (req,res)=>{
  const text = req.body.text || req.query.text
  if(!text) return res.status(400).send({error:'Text is required'})
  console.log(chalk.blue('✉️ /wa/send → Отправка текста в WhatsApp:'), text)
  await sendToWhatsApp(text)
  res.send({status:'ok', text})
})

app.get('/wa/groups', async (req,res)=>{
  if(!sock) return res.status(500).send({error:'WhatsApp не подключен'})
  try{
    const groups = await sock.groupFetchAllParticipating()
    const groupList = Object.values(groups).map(g=>({id:g.id, name:g.subject}))
    console.log(chalk.blue('📋 /wa/groups → Список групп WhatsApp получен'))
    res.send(groupList)
  } catch(e){ console.error(e); res.status(500).send({error:e.message}) }
})

app.post('/tg/send', async (req,res)=>{
  const text = req.body.text || req.query.text
  if(!text) return res.status(400).send({error:'Text is required'})
  console.log(chalk.blue('✉️ /tg/send → Отправка текста в Telegram:'), text)
  await sendTelegramNotification(text)
  res.send({status:'ok', text})
})

app.get('/tg/status', (req,res)=>{
  console.log(chalk.blue('📊 /tg/status → Статус Telegram и источник сообщений'))
  res.send({
    telegram: telegramConnected,
    source: TG_SOURCE
  })
})

// ---------------- Telegram ----------------
const tgClient = new TelegramClient(
  new StringSession(TELEGRAM_STRING_SESSION),
  Number(TELEGRAM_API_ID),
  TELEGRAM_API_HASH,
  { connectionRetries: 5 }
)

async function sendTelegramNotification(text) {
  if (!telegramConnected) return
  try {
    await tgClient.sendMessage(TG_SOURCE, { message: text })
    console.log(chalk.green('📨 Telegram:'), text)
    return true
  } catch(e) { 
    console.error(chalk.red('⚠️ Telegram send failed:'), e) 
    return false
  }
}

tgClient.addEventHandler(async (event) => {
  const message = event.message
  if (!message) return
  try {
    const sender = await message.getSender()
    const senderIdStr = sender?.id ? String(sender.id) : ''
    const senderUsername = sender?.username ? sender.username.toLowerCase() : ''
    const isFromSource = senderUsername === TG_SOURCE || senderIdStr === TG_SOURCE
    if (isFromSource && message.message?.trim()) await sendToWhatsApp(message.message)
  } catch (e) { console.error(chalk.red('⚠️ Telegram event error:'), e) }
}, new NewMessage({}))

async function initTelegram() {
  console.log(chalk.cyan('🚀 Подключение к Telegram...'))
  await tgClient.connect()
  telegramConnected = true
  console.log(chalk.green('✅ Telegram подключён. Источник сообщений:'), TG_SOURCE)
}

// ---------------- Утилиты ----------------
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) }
function rmDirSafe(dir) { try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }) } catch(e){console.error(e)} }

// ---------------- Gist ----------------
async function saveSessionToGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return
  try {
    const files = {}
    const authFiles = fs.readdirSync(AUTH_DIR)
    for (const f of authFiles) files[f] = { content: fs.readFileSync(path.join(AUTH_DIR,f),'utf-8') }
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: { Authorization:`token ${GITHUB_TOKEN}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ files })
    })
    console.log(chalk.green('💾 Сессия WhatsApp сохранена в Gist'))
  } catch(e){ console.error(chalk.red('❌ Ошибка сохранения сессии в Gist:'), e) }
}

async function loadSessionFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return false
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: { Authorization:`token ${GITHUB_TOKEN}` }})
    const data = await res.json()
    if (!data.files) { console.log(chalk.yellow('⚠️ Сессия из Gist не найдена')); return false }
    ensureDir(AUTH_DIR)
    for (const name in data.files) fs.writeFileSync(path.join(AUTH_DIR,name), data.files[name].content,'utf-8')
    console.log(chalk.green('📥 Сессия WhatsApp загружена из Gist'))
    return true
  } catch(e){ console.error(chalk.red('❌ Ошибка загрузки сессии из Gist:'), e); return false }
}

// ---------------- WhatsApp ----------------
async function startWhatsApp({ reset = false } = {}) {
  if (reset) { 
    rmDirSafe(AUTH_DIR)
    sock?.logout?.(); sock?.end?.(); sock = null; 
    sessionLoaded=false; waConnectionStatus='disconnected' 
  }

  if (!reset) {
    sessionLoaded = await loadSessionFromGist()
    if (!sessionLoaded) { 
      console.log(chalk.yellow('⚠️ Сессия из Gist невалидна, сброс...')); 
      return startWhatsApp({ reset:true }) 
    }
  }

  ensureDir(AUTH_DIR)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  sock = makeWASocket({ auth: state, browser: Browsers.appropriate('Render','Chrome') })

  sock.ev.on('creds.update', async ()=> { await saveCreds(); await saveSessionToGist() })

  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect })=>{
    waConnectionStatus = connection==='open'?'connected':connection==='close'?'disconnected':waConnectionStatus

    if (qr) {
      lastQR = qr
      waConnectionStatus='awaiting_qr'
      qrcodeTerminal.generate(qr,{small:true})
      console.log(chalk.yellow(`🌍 QR код для WhatsApp: ${DOMAIN}/wa/qr`))
      await sendTelegramNotification('⚠️ Новый QR для WhatsApp')
    }

    if (connection==='open') {
      lastQR = null
      console.log(chalk.green('✅ WhatsApp подключён'))
      sessionLoaded = true
      qrTimer && clearInterval(qrTimer)

      // Найти группу и отправить сервисное сообщение
      await cacheGroupJid(true)
    }

    if (connection==='close') {
      console.log(chalk.red('❌ WhatsApp отключён'), lastDisconnect?.error?.message||'')
      await sendTelegramNotification(`❌ WhatsApp отключён`)
      const shouldRestart = lastDisconnect?.error?.output?.statusCode !== 401
      if (shouldRestart) setTimeout(()=>startWhatsApp({reset:false}),5000)
      if (!qrTimer) startQRTimer()
    }
  })

  sock.ev.on('messages.upsert', (msg) => {
    console.log(chalk.gray('📥 Новое сообщение в WhatsApp:'), msg.messages?.[0]?.message?.conversation || '')
  })

  sock.ev.on('connection.error', (err) => {
    console.error(chalk.red('❌ Ошибка соединения WhatsApp:'), err)
  })
}

// Таймер авто-обновления QR каждые 60 секунд
function startQRTimer() {
  if (qrTimer) clearInterval(qrTimer)
  qrTimer = setInterval(()=>{
    if(waConnectionStatus!=='connected' && sock && sock.authState) sock.ev.emit('connection.update',{connection:'close'})
  },60000)
}

async function cacheGroupJid(sendWelcome=false) {
  try {
    console.log(chalk.gray('🔎 Поиск группы WhatsApp:'), WHATSAPP_GROUP_NAME)
    const groups = await sock.groupFetchAllParticipating()
    const target = Object.values(groups).find(g => (g.subject||'').trim().toLowerCase() === (WHATSAPP_GROUP_NAME||'').trim().toLowerCase())

    if(target){ 
      waGroupJid = target.id
      console.log(chalk.green(`✅ Группа WhatsApp найдена: ${target.subject}`)) 

      if(sendWelcome){
        console.log(chalk.blue('💬 Отправка сервисного сообщения в WhatsApp'))
        await sendToWhatsApp('🚨 Радар активен')
      }
    } else { 
      waGroupJid = null
      console.log(chalk.red('❌ Группа WhatsApp не найдена')) 
    }
  } catch(e){ 
    console.error(chalk.red('❌ Ошибка получения списка групп:'), e) 
  }
}

async function sendToWhatsApp(text) {
  if(!sock){ console.log(chalk.yellow('⏳ WhatsApp не подключен')); return }
  if(!waGroupJid) await cacheGroupJid()
  if(!waGroupJid){ console.log(chalk.red('❌ Группа WhatsApp не найдена')); return }
  try{ await sock.sendMessage(waGroupJid,{text}); console.log(chalk.green('➡️ Отправлено в WhatsApp')) }
  catch(e){ console.error(chalk.red('❌ Ошибка отправки:'), e) }
}

// ---------------- Старт ----------------
;(async ()=>{
  try {
    console.log(chalk.cyan('🚀 Старт моста Telegram → WhatsApp'))
    await initTelegram()
    await startWhatsApp()
    app.listen(Number(PORT), () => {
      console.log(chalk.cyan(`🌐 HTTP сервер на порту ${PORT}`))
      console.log(chalk.green('💻 Доступные HTTP команды:'))
      console.log(`${DOMAIN}/ping - проверка доступности сервиса`)
      console.log(`${DOMAIN}/healthz - health check`)
      console.log(`${DOMAIN}/wa/status - статус WhatsApp и Telegram`)
      console.log(`${DOMAIN}/wa/reset - сброс сессии WhatsApp`)
      console.log(`${DOMAIN}/wa/qr - получить QR-код (img)`)
      console.log(`${DOMAIN}/wa/qr-ascii - получить QR-код в ASCII`)
      console.log(`${DOMAIN}/wa/send - отправка текста в WhatsApp (POST/GET text)`)
      console.log(`${DOMAIN}/wa/groups - получить список групп WhatsApp`)
      console.log(`${DOMAIN}/tg/send - отправка текста в Telegram (POST/GET text)`)
      console.log(`${DOMAIN}/tg/status - статус Telegram`)
    })
    console.log(chalk.green('✅ Мост запущен и работает'))
  } catch(err){ console.error(chalk.red('❌ Ошибка старта:'), err); process.exit(1) }
})()

process.on('SIGINT',()=>process.exit(0))
process.on('SIGTERM',()=>process.exit(0))
