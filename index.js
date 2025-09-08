import 'dotenv/config'
import express from 'express'
import { PORT, UI_DOMAIN } from './config.js'
import { infoLog } from './logger.js'
import { startTelegram } from './telegram.js'
import { startWhatsApp } from './whatsapp.js'
import { registerRoutes } from './routes.js'
import { serveUI } from './ui.js'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

registerRoutes(app)
serveUI(app)

;(async () => {
  try {
    await startTelegram()
    await startWhatsApp({ reset: false })
    app.listen(PORT, () => {
      infoLog(`🌐 HTTP доступен: ${UI_DOMAIN} (port ${PORT})`)
    })
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
})()
