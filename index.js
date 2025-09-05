import 'dotenv/config'
import express from 'express'
import qrcode from 'qrcode-terminal'
import makeWASocket, { useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'

const app = express()
const PORT = process.env.PORT || 3000

// ------------------- MOCK: сюда вставь свою реальную логику -------------------
let logs = []
let qrString = 'QR пока пуст'
function log(msg) {
  console.log(msg)
  logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`)
  if (logs.length > 200) logs.shift()
}
// ------------------------------------------------------------------------------

// ------------------- API -------------------
app.use(express.json())

app.get('/ping', (req, res) => {
  log('Ping получен')
  res.send('pong')
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

app.get('/logs', (req, res) => {
  res.json({ logs })
})

app.get('/qr', (req, res) => {
  res.json({ qr: qrString })
})

app.post('/sendwa', (req, res) => {
  const { message } = req.body
  log(`Отправка в WA: ${message}`)
  // тут вызов в реальный WA сокет
  res.json({ sent: true })
})

app.get('/wastatus', (req, res) => res.json({ status: 'WA подключен' }))
app.get('/tgstatus', (req, res) => res.json({ status: 'TG подключен' }))
app.get('/wagroups', (req, res) => res.json({ groups: ['Группа1', 'Группа2'] }))
app.get('/resetwa', (req, res) => { log('Сброс WA'); res.send('ok') })
app.get('/reloginwa', (req, res) => { log('Релогин WA'); res.send('ok') })

// ------------------- FRONT -------------------
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Bridge Control</title>
  <style>
    body { font-family: sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; }
    header { background: #222; color: #fff; padding: 10px; }
    main { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 10px; }
    #controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
    button { padding: 8px 12px; border: none; border-radius: 6px; cursor: pointer; background: #4a90e2; color: #fff; }
    button:hover { background: #357abd; }
    #qr { margin: 10px 0; font-family: monospace; white-space: pre; }
    #sendForm { margin: 10px 0; }
    footer { height: 200px; overflow-y: auto; background: #111; color: #0f0; font-family: monospace; padding: 5px; }
  </style>
</head>
<body>
  <header><h2>Telegram ↔ WhatsApp Bridge</h2></header>
  <main>
    <div id="controls">
      <button onclick="api('ping')">Ping</button>
      <button onclick="api('health')">Health</button>
      <button onclick="api('tgstatus')">TG Status</button>
      <button onclick="api('wastatus')">WA Status</button>
      <button onclick="api('wagroups')">WA Groups</button>
      <button onclick="api('resetwa')">Reset WA</button>
      <button onclick="api('reloginwa')">Relogin WA</button>
      <button onclick="loadQR()">QR ASCII</button>
      <button onclick="loadLogs()">Logs</button>
      <button onclick="api('health')">Обновить статус</button>
    </div>
    <div id="qr">QR пока пуст</div>
    <form id="sendForm">
      <input type="text" id="msg" placeholder="Сообщение в WA" required>
      <button type="submit">Send → WA</button>
    </form>
  </main>
  <footer id="logs"></footer>

  <script>
    async function api(endpoint) {
      let r = await fetch('/' + endpoint)
      let t = await r.text()
      console.log(endpoint, t)
      loadLogs()
    }

    async function loadLogs() {
      let r = await fetch('/logs')
      let j = await r.json()
      document.getElementById('logs').textContent = j.logs.join('\\n')
    }

    async function loadQR() {
      let r = await fetch('/qr')
      let j = await r.json()
      document.getElementById('qr').textContent = j.qr
    }

    document.getElementById('sendForm').addEventListener('submit', async e => {
      e.preventDefault()
      let msg = document.getElementById('msg').value
      await fetch('/sendwa', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({message: msg}) })
      document.getElementById('msg').value = ''
      loadLogs()
    })

    setInterval(loadLogs, 3000)
    setInterval(loadQR, 10000)
    loadLogs()
    loadQR()
  </script>
</body>
</html>
  `)
})

// ------------------- START -------------------
app.listen(PORT, () => log('Server running on http://localhost:' + PORT))
