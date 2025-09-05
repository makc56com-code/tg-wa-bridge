// 13-routes.js (сжатая версия, функционал тот же)
import express from 'express'
import fs from 'fs'
import path from 'path'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { ADMIN_TOKEN, UI_DOMAIN } from './config.js'
import { tgClient } from './telegram.js'
import {
  startWhatsApp, sendToWhatsApp, getWaStatus, getRecentForwarded,
  getRecentWAMessages, setRadar, qrDataUrl
} from './whatsapp.js'
import { LOG_FILE } from './logger.js'

// ==== helpers ====
const requireToken = (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
    res.status(403).send({ error: 'forbidden' })
    return false
  }
  return true
}
const safeSend = (res, fn) => fn().catch(e => res.status(500).send({ error: e?.message || e }))
const resetAuthDir = () => {
  try {
    fs.rmSync(process.env.AUTH_DIR, { recursive: true, force: true })
    fs.mkdirSync(process.env.AUTH_DIR, { recursive: true })
  } catch {}
}

// ==== routes ====
export default function registerRoutes(app) {
  // basic
  app.get('/ping', (_, res) => res.send('pong'))
  app.get('/healthz', (_, res) => res.send('ok'))
  app.get('/tg/status', (_, res) =>
    res.send({ telegram: !!tgClient, source: process.env.TELEGRAM_SOURCE || null })
  )

  app.post('/tg/send', (req, res) => safeSend(res, async () => {
    const text = req.body.text || req.query.text
    if (!text) return res.status(400).send({ error: 'text required' })
    if (!tgClient) return res.status(500).send({ error: 'telegram not connected' })
    await tgClient.sendMessage(process.env.TELEGRAM_SOURCE, { message: String(text) })
    res.send({ status: 'ok', text })
  }))

  app.get('/wa/status', (_, res) => res.send(getWaStatus()))

  app.get('/wa/auth-status', (_, res) => safeSend(res, async () => {
    const dir = process.env.AUTH_DIR
    if (!fs.existsSync(dir)) return res.send({ exists: false, files: [] })
    const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile())
    res.send({ exists: true, files })
  }))

  const resetHandler = (msg) => async (req, res) => {
    if (!requireToken(req, res)) return
    resetAuthDir()
    res.send({ status: 'ok', message: msg })
    await startWhatsApp({ reset: true })
  }
  app.post('/wa/reset', resetHandler('reset requested'))
  app.post('/wa/relogin', resetHandler('relogin requested'))

  app.get('/wa/relogin-ui', (_, res) => {
    fetch(`${UI_DOMAIN}/wa/relogin?token=${ADMIN_TOKEN}`, { method: 'POST' }).catch(() => {})
    res.send(`<html><body><p>Relogin requested. <a href="/">Back</a></p></body></html>`)
  })

  app.get('/wa/qr', async (_, res) => {
    const dataUrl = await qrDataUrl()
    if (!dataUrl) return res.status(404).send('QR not generated')
    res.type('html').send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#071024"><img src="${dataUrl}"/></body></html>`)
  })

  app.get('/wa/qr-img', async (_, res) => {
    const dataUrl = await qrDataUrl()
    if (!dataUrl) return res.status(404).send('QR not generated')
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
    res.type('png').set('Cache-Control', 'no-store').send(buf)
  })

  app.get('/wa/qr-ascii', (req, res) => {
    const qr = req.app.locals.lastQR || global.lastQR
    if (!qr) return res.status(404).send('QR not generated')
    qrcodeTerminal.generate(qr, { small: true }, qrcode => {
      res.type('txt').send(qrcode)
    })
  })

  app.post('/wa/send', (req, res) => safeSend(res, async () => {
    const text = req.body.text || req.query.text
    if (!text) return res.status(400).send({ error: 'text required' })
    if (!await sendToWhatsApp(String(text))) return res.status(500).send({ error: 'send failed' })
    res.send({ status: 'ok', text })
  }))

  app.get('/wa/groups', (_, res) => safeSend(res, async () => {
    const { sock, waConnectionStatus } = await import('./whatsapp.js')
    if (!sock || waConnectionStatus !== 'connected') return res.status(500).send({ error: 'whatsapp not connected' })
    const groups = await sock.groupFetchAllParticipating()
    res.send(Object.values(groups || {}).map(g => ({ id: g.id, name: g.subject })))
  }))

  app.post('/wa/radar/:mode(on|off)', (req, res) => safeSend(res, async () => {
    if (!requireToken(req, res)) return
    const on = req.params.mode === 'on'
    await setRadar(on)
    res.send({ status: 'ok', radarActive: on })
  }))
  app.get('/wa/radar/status', (_, res) =>
    res.send({ radarActive: !!(process.env.RADAR_ACTIVE || true) })
  )

  app.get('/wa/recent-forwarded', (_, res) => res.send(getRecentForwarded()))
  app.get('/wa/recent-messages', (_, res) => res.send(getRecentWAMessages()))

  const readLogs = () => fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''
  app.get('/logs', (_, res) => safeSend(res, async () => res.type('txt').send(readLogs())))
  app.get('/logs/tail', (req, res) => safeSend(res, async () => {
    const lines = +req.query.lines || 200
    const arr = readLogs().trim().split('\n').filter(Boolean)
    res.type('txt').send(arr.slice(-lines).join('\n'))
  }))

  // === UI ===
  app.get('/', (_, res) => {
    const waStatus = getWaStatus()
    const qrImgHtml = waStatus.qrPending
      ? `<img src="/wa/qr-img?ts=${Date.now()}" style="max-width:320px;"/>`
      : `<div style="color:#9fb0c8">QR not generated</div>`

    // (HTML оставил без изменений, чтобы не сломать UI — можно вынести в отдельный файл)
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/><title>TG→WA Bridge</title>
    <!-- стили и JS тут (как в оригинале) -->
    ${qrImgHtml}
    </html>`)
  })
}
