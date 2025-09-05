import express from 'express'
import { PORT } from './config.js'
import registerRoutes from './routes.js'
import { startTelegram } from './telegram.js'
import { startWhatsApp } from './whatsapp.js'
import { infoLog, errorLog } from './logger.js'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

registerRoutes(app)

;(async () => {
  try {
    await startTelegram()
    await startWhatsApp({ reset: false })
    app.listen(Number(PORT), () => {
      infoLog(`🌐 HTTP доступен: http://localhost:${PORT} (port ${PORT})`)
      infoLog('Available endpoints: /, /ping, /healthz, /tg/status, /tg/send, /wa/status, /wa/groups, /wa/send, /wa/qr, /wa/qr-img, /wa/qr-ascii, /wa/reset, /wa/relogin, /wa/auth-status, /wa/recent-forwarded, /wa/recent-messages, /logs, /logs/tail, /wa/radar/on, /wa/radar/off, /wa/radar/status')
    })
  } catch (e) {
    errorLog('❌ Ошибка старта: ' + (e?.message || e))
    process.exit(1)
  }
})()

process.on('SIGINT', async () => { infoLog('👋 Завершение...'); process.exit(0) })
process.on('SIGTERM', async () => { infoLog('👋 Завершение...'); process.exit(0) })
