// index.js
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
import QRCode from 'qrcode'

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

// Root — UI with buttons and dynamic QR preview
app.get('/', (req, res) => {
  const qrPending = !!lastQR
  const html = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Telegram → WhatsApp мост</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body{font-family:Inter,Segoe UI,Roboto,Arial; background:#0f1724; color:#e6eef8; margin:0; padding:24px; display:flex; gap:24px; flex-direction:column; align-items:center;}
      .card{background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)); border-radius:12px; padding:18px; width:100%; max-width:920px; box-shadow:0 8px 30px rgba(2,6,23,0.6);}
      h1{margin:0 0 8px 0; font-size:20px}
      p.sub{margin:0 0 16px 0; color:#b9c6d8}
      .grid{display:grid; grid-template-columns: 1fr 320px; gap:18px; align-items:start;}
      .buttons{display:flex; flex-wrap:wrap; gap:10px}
      a.button{display:inline-block; text-decoration:none; padding:10px 14px; border-radius:10px; background:#06b6d4; color:#04202a; font-weight:600}
      a.ghost{background:transparent; border:1px solid rgba(255,255,255,0.06); color:#dcecff}
      .qr-wrap{display:flex;flex-direction:column; gap:8px; align-items:center}
      .qr-img{width:280px; height:280px; border-radius:8px; background:#071024; display:flex; align-items:center; justify-content:center; overflow:hidden; padding:8px}
      .meta{font-size:13px; color:#9fb0c8}
      .status{margin-top:10px; font-weight:600}
      .small{font-size:13px; color:#9fb0c8}
      .note{margin-top:12px; font-size:13px; color:#94aacf}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>🤖 Telegram → WhatsApp мост</h1>
      <p class="sub">Управление сервисом и QR для авторизации WhatsApp</p>

      <div class="grid">
        <div>
          <div class="buttons">
            <a class="button" href="/ping" target="_blank">Ping</a>
            <a class="button ghost" href="/healthz" target="_blank">Health</a>
            <a class="button" href="/tg/status" target="_blank">Telegram Status</a>
            <a class="button" href="/wa/status" target="_blank">WhatsApp Status</a>
            <a class="button ghost" href="/wa/groups" target="_blank">Get WA Groups</a>
            <a class="button" href="/tg/send?text=Hello%20from%20bridge" target="_blank">Send → Telegram</a>
            <a class="button ghost" href="/wa/send?text=Hello%20from%20bridge" target="_blank">Send → WhatsApp</a>
            <a class="button" href="/wa/reset" target="_blank">Reset WA Session</a>
            <a class="button ghost" href="/wa/qr-ascii" target="_blank">QR ASCII</a>
          </div>

          <div class="note">
            <div class="small">Domain: ${DOMAIN}</div>
            <div class="status">WA connection: <strong>${waConnectionStatus}</strong> · Telegram: <strong>${telegramConnected ? 'connected' : 'disconnected'}</strong></div>
            <div class="small">Target WA group: <strong>${WHATSAPP_GROUP_NAME || '—'}</strong></div>
            <div style="margin-top:8px" class="small">QR pending: <strong>${qrPending}</strong></div>
          </div>
        </div>

        <div class="qr-wrap">
          <div class="qr-img" id="qrbox">
            ${ lastQR ? `<img id="qrimage" src="/wa/qr-img?ts=${Date.now()}" style="width:100%;height:100%;object-fit:contain" />` : `<div style="color:#274058">QR not generated</div>` }
          </div>
          <div class="meta">QR автоматически обновляется (каждые 10s) — если появляется новый QR, отсканируйте его в WhatsApp</div>
        </div>
      </div>
    </div>

    <script>
      // simple poll to refresh QR image when available
      setInterval(async () => {
        try {
          const res = await fetch('/wa/status');
          if(!res.ok) return;
          const json = await res.json();
          const pending = json.qrPending;
          const img = document.getElementById('qrimage');
          if(pending){
            if(!img){
              const box = document.getElementById('qrbox');
              const i = document.createElement('img');
              i.id = 'qrimage';
              i.style.width = '100%';
              i.style.height = '100%';
              i.style.objectFit = 'contain';
              box.innerHTML = '';
              box.appendChild(i);
              i.src = '/wa/qr-img?ts=' + Date.now();
            } else {
              img.src = '/wa/qr-img?ts=' + Date.now();
            }
          } else {
            // remove image if connected
            const box = document.getElementById('qrbox');
            if(!pending && box){
              // keep last image but show overlay text
            }
          }
        } catch(e){}
      }, 10000);
    </script>
  </body>
  </html>`
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.send(html)
})

app.get('/ping', (req, res) => res.send('pong'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))

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

// Serve QR as an embeddable PNG image (binary)
app.get('/wa/qr-img', async (req, res) => {
  if (!lastQR) return res.status(404).send('QR код пока не сгенерирован')
  try {
    const dataUrl = await QRCode.toDataURL(lastQR, { margin: 1, width: 512 })
    const base64 = dataUrl.split(',')[1]
    const buffer = Buffer.from(base64, 'base64')
    res.setHeader('Content-Type', 'image/png')
    // prevent caching so the client always fetches latest
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.send(buffer)
  } catch (e) {
    console.error('Ошибка генерации QR image:', e)
    res.status(500).send('QR generation error')
  }
})

app.get('/wa/qr', (req, res) => {
  if (!lastQR) return res.status(404).send('QR код пока не сгенерирован')
  // render small HTML page with QR for quick view
  QRCode.toDataURL(lastQR, { margin: 1, width: 640 })
    .then(url => {
      const html = `<!doctype html><html><head><meta charset="utf-8"/><title>WA QR</title></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#071024"><img src="${url}" style="max-width:95%;max-height:95%"/></body></html>`
      res.setHeader('Content-Type','text/html; charset=utf-8')
      res.send(html)
    })
    .catch(e => res.status(500).send(e.message || e))
})

app.get('/wa/qr-ascii', (req, res) => {
  if(!lastQR) return res.status(404).send('QR код пока не сгенерирован')
  qrcodeTerminal.generate(lastQR, { small: true }, qrcode => {
    console.log(chalk.yellow('🌍 QR ASCII для WhatsApp:')); console.log(qrcode)
    res.setHeader('Content-Type','text/plain; charset=utf-8')
    res.send(qrcode)
  })
})

app.post('/wa/send', async (req, res) => {
  const text = req.body.text || req.query.text
  if (!text) return res.status(400).send({ error: 'Text is required' })
  console.log(chalk.blue('✉️ /wa/send → Отправка текста в WhatsApp:'), text)
  await sendToWhatsApp(text)
  res.send({ status: 'ok', text })
})

app.get('/wa/groups', async (req, res) => {
  if (!sock) return res.status(500).send({ error: 'WhatsApp не подключен' })
  try {
    const groups = await sock.groupFetchAllParticipating()
    const groupList = Object.values(groups).map(g => ({ id: g.id, name: g.subject }))
    console.log(chalk.blue('📋 /wa/groups → Список групп WhatsApp получен'))
    res.send(groupList)
  } catch (e) { console.error(e); res.status(500).send({ error: e?.message || e }) }
})

app.post('/tg/send', async (req, res) => {
  const text = req.body.text || req.query.text
  if (!text) return res.status(400).send({ error: 'Text is required' })
  console.log(chalk.blue('✉️ /tg/send → Отправка текста в Telegram:'), text)
  await sendTelegramNotification(text)
  res.send({ status: 'ok', text })
})

app.get('/tg/status', (req, res) => {
  console.log(chalk.blue('📊 /tg/status → Статус Telegram и источник сообщений'))
  res.send({
    telegram: telegramConnected,
    source: TG_SOURCE
  })
})

// ---------------- Telegram ----------------
const tgClient = new TelegramClient(
  new StringSession(TELEGRAM_STRING_SESSION || ''),
  Number(TELEGRAM_API_ID),
  TELEGRAM_API_HASH,
  { connectionRetries: 5 }
)

async function sendTelegramNotification(text) {
  if (!TELEGRAM_STRING_SESSION) {
    console.log(chalk.yellow('⚠️ TELEGRAM_STRING_SESSION отсутствует — пропускаем отправку в Telegram'))
    return false
  }
  if (!telegramConnected) {
    console.log(chalk.yellow('⚠️ Telegram не подключён — сообщение не отправлено'))
    return false
  }
  try {
    // TG_SOURCE может быть username или id; TG_SOURCE пуст — skip
    if (!TG_SOURCE) {
      console.log(chalk.yellow('⚠️ TELEGRAM_SOURCE не указан — пропускаем отправку'))
      return false
    }
    await tgClient.sendMessage(TG_SOURCE, { message: text })
    console.log(chalk.green('📨 Telegram:'), text)
    return true
  } catch (e) {
    console.error(chalk.red('⚠️ Telegram send failed:'), e)
    return false
  }
}

// Telegram event handler: жёсткая, но безопасная проверка текста
tgClient.addEventHandler(async (event) => {
  const message = event.message
  if (!message) return
  try {
    // Попытка достать текст сообщения — поддерживаем разные форматы
    let text = null
    // Varying shapes depending on library internals
    if (message.message && typeof message.message === 'string') text = message.message
    else if (message.message?.message?.conversation) text = message.message.message.conversation
    else if (message.message?.message?.text) text = message.message.message.text
    else if (message.message?.message) {
      // try to stringify small text payloads
      const mm = message.message.message
      if (typeof mm === 'object' && mm !== null && mm.text) text = mm.text
    }

    const sender = await message.getSender().catch(()=>null)
    const senderIdStr = sender?.id ? String(sender.id) : ''
    const senderUsername = sender?.username ? ('' + sender.username).toLowerCase() : ''
    const isFromSource = (TG_SOURCE && (senderUsername === TG_SOURCE || senderIdStr === TG_SOURCE))
    if (isFromSource && text && String(text).trim()) {
      await sendToWhatsApp(String(text).trim())
    }
  } catch (e) { console.error(chalk.red('⚠️ Telegram event error:'), e) }
}, new NewMessage({}))

async function initTelegram() {
  try {
    console.log(chalk.cyan('🚀 Подключение к Telegram...'))
    await tgClient.connect()
    telegramConnected = true
    console.log(chalk.green('✅ Telegram подключён. Источник сообщений:'), TG_SOURCE)
  } catch (e) {
    console.error(chalk.red('❌ Ошибка подключения к Telegram:'), e)
    telegramConnected = false
  }
}

// ---------------- Gist Session ----------------
async function saveSessionToGist(stateFiles) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    // silent if not configured
    return
  }
  try {
    const files = {}
    for (const f in stateFiles) files[f] = { content: stateFiles[f] }
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files })
    })
    console.log(chalk.green('💾 Сессия WhatsApp сохранена в Gist'))
  } catch (e) { console.error(chalk.red('❌ Ошибка сохранения сессии в Gist:'), e) }
}

async function loadSessionFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return null
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    if (!res.ok) {
      console.log(chalk.yellow('⚠️ Не удалось загрузить Gist:', res.status))
      return null
    }
    const data = await res.json()
    if (!data.files) { console.log(chalk.yellow('⚠️ Сессия из Gist не найдена')); return null }
    console.log(chalk.green('📥 Сессия WhatsApp загружена из Gist (в памяти)'))
    return Object.fromEntries(Object.entries(data.files).map(([k, v]) => [k, v.content]))
  } catch (e) { console.error(chalk.red('❌ Ошибка загрузки сессии из Gist:'), e); return null }
}

// ---------------- WhatsApp ----------------
async function startWhatsApp({ reset = false } = {}) {
  if (reset) {
    try { sock?.logout?.(); sock?.end?.(); } catch(e){}
    sock = null
    sessionLoaded = false
    waConnectionStatus = 'disconnected'
    lastQR = null
  }

  // ensure auth dir exists
  try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) { console.error('Не удалось создать AUTH_DIR', e) }

  // Попытка загрузить сессию из Gist — и записать её в AUTH_DIR до инициализации useMultiFileAuthState
  let authStateFiles = reset ? null : await loadSessionFromGist()
  if (authStateFiles) {
    try {
      for (const f of Object.keys(authStateFiles)) {
        const target = path.join(AUTH_DIR, f)
        fs.writeFileSync(target, authStateFiles[f], 'utf-8')
      }
      console.log(chalk.green('💾 Сессия записана в локальный AUTH_DIR перед инициализацией Baileys'))
    } catch (e) {
      console.error(chalk.red('❌ Ошибка записи файлов сессии в AUTH_DIR:'), e)
    }
  }

  // Инициализация auth state (Baileys прочитает файлы из AUTH_DIR если они там есть)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  // Создаём сокет
  sock = makeWASocket({ auth: state, browser: Browsers.appropriate('Render', 'Chrome') })

  // Когда cred'ы обновляются — сохраняем локально (useMultiFileAuthState делает это) и загружаем файлы в Gist
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds()
    } catch (e) { /* ok */ }
    // Подождём небольшую паузу, затем прочитаем все файлы и отправим на Gist
    try {
      const files = {}
      for (const f of fs.readdirSync(AUTH_DIR)) {
        const fp = path.join(AUTH_DIR, f)
        if (fs.statSync(fp).isFile()) files[f] = fs.readFileSync(fp, 'utf-8')
      }
      await saveSessionToGist(files)
    } catch (e) {
      console.error(chalk.red('❌ Ошибка при подготовке файлов для Gist:'), e)
    }
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update
    if (connection === 'open') waConnectionStatus = 'connected'
    else if (connection === 'close') waConnectionStatus = 'disconnected'
    else if (connection === 'connecting') waConnectionStatus = 'connecting'

    // QR генерируем только когда он приходит
    if (qr && waConnectionStatus !== 'connected') {
      lastQR = qr
      waConnectionStatus = 'awaiting_qr'
      qrcodeTerminal.generate(qr, { small: true })
      console.log(chalk.yellow(`🌍 QR код для WhatsApp: ${DOMAIN}/wa/qr`))
      // уведомляем в Telegram если подключено
      await sendTelegramNotification('⚠️ Новый QR для WhatsApp')
    }

    if (connection === 'open') {
      lastQR = null
      console.log(chalk.green('✅ WhatsApp подключён'))
      sessionLoaded = true
      qrTimer && clearInterval(qrTimer)
      await cacheGroupJid(true)
    }

    if (connection === 'close') {
      console.log(chalk.red('❌ WhatsApp отключён'), lastDisconnect?.error?.message || '')
      await sendTelegramNotification('❌ WhatsApp отключён')
      // если причина не авторизация — пытаемся переподключиться
      if (lastDisconnect?.error?.output?.statusCode !== 401) setTimeout(() => startWhatsApp({ reset: false }), 5000)
      if (!qrTimer) startQRTimer()
    }
  })

  sock.ev.on('messages.upsert', async (msg) => {
    const text = msg.messages?.[0]?.message?.conversation || msg.messages?.[0]?.message?.extendedText?.text
    if (text) console.log(chalk.gray('📥 Новое сообщение в WhatsApp:'), text)
  })

  sock.ev.on('connection.error', (err) => {
    console.error(chalk.red('❌ Ошибка соединения WhatsApp:'), err)
  })
}

// Таймер авто-обновления QR каждые 60 секунд — если не подключены, пробуждаем попытку
function startQRTimer() {
  if (qrTimer) clearInterval(qrTimer)
  qrTimer = setInterval(() => {
    if (waConnectionStatus !== 'connected' && sock && sock.authState) {
      // форсируем генерацию новой QR (эмулируем закрытие), Baileys сам предоставит новый qr в connection.update
      sock.ev.emit('connection.update', { connection: 'close' })
    }
  }, 60000)
}

// ---------------- Группы и приветствие ----------------
async function cacheGroupJid(sendWelcome = false) {
  try {
    console.log(chalk.gray('🔎 Поиск группы WhatsApp:'), WHATSAPP_GROUP_NAME)
    if (!sock) { console.log(chalk.yellow('⏳ sock не инициализирован')); return }
    const groups = await sock.groupFetchAllParticipating()
    const groupNames = Object.values(groups).map(g => g.subject)
    for (const name of groupNames) {
      console.log(chalk.gray(`🔹 Проверка группы: ${name}`))
    }
    const target = Object.values(groups).find(g => (g.subject || '').trim().toLowerCase() === (WHATSAPP_GROUP_NAME || '').trim().toLowerCase())
    if (target) {
      waGroupJid = target.id
      console.log(chalk.green(`✅ Группа WhatsApp найдена: ${target.subject}`))
      if (sendWelcome) {
        const welcome = `[🔧 сервисное сообщение 🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН 🚨]`
        console.log(chalk.blue('💬 Отправка сервисного сообщения в WhatsApp'))
        await sendToWhatsApp(welcome)
      }
    } else {
      waGroupJid = null
      console.log(chalk.red('❌ Группа WhatsApp не найдена'))
    }
  } catch (e) { console.error(chalk.red('❌ Ошибка получения списка групп:'), e) }
}

async function sendToWhatsApp(text) {
  if (!sock) { console.log(chalk.yellow('⏳ WhatsApp не подключен')); return }
  if (!waGroupJid) await cacheGroupJid()
  if (!waGroupJid) { console.log(chalk.red('❌ Группа WhatsApp не найдена')); return }
  try {
    await new Promise(r => setTimeout(r, 500)) // задержка для надежности
    await sock.sendMessage(waGroupJid, { text })
    console.log(chalk.green('➡️ Отправлено в WhatsApp'))
  } catch (e) { console.error(chalk.red('❌ Ошибка отправки:'), e) }
}

// ---------------- Старт ----------------
;(async () => {
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
      console.log(`${DOMAIN}/wa/qr-img - получить QR-код (PNG image for embedding)`)
      console.log(`${DOMAIN}/wa/send - отправка текста в WhatsApp (POST/GET text)`)
      console.log(`${DOMAIN}/wa/groups - получить список групп WhatsApp`)
      console.log(`${DOMAIN}/tg/send - отправка текста в Telegram (POST/GET text)`)
      console.log(`${DOMAIN}/tg/status - статус Telegram`)
    })
    console.log(chalk.green('✅ Мост запущен и работает'))
  } catch (err) { console.error(chalk.red('❌ Ошибка старта:'), err); process.exit(1) }
})()

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
