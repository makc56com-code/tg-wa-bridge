import fs from 'fs'
import path from 'path'
import axios from 'axios'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'

import { ADMIN_TOKEN, AUTH_DIR, UI_DOMAIN, CONFIG_GROUP_ID, CONFIG_GROUP_NAME, LOG_FILE } from './config.js'
import { tgClient } from './telegram.js'
import { sendToWhatsApp, recentForwarded, recentWAMessages, getWaStatus, lastQR, waConnectionStatus, cachedGroupJid, startWhatsApp } from './whatsapp.js'
import { infoLog, warnLog } from './logger.js'

// === REGISTER ALL ROUTES ===
export function registerRoutes(app) {
  // basic
  app.get('/ping', (req, res) => res.send('pong'))
  app.get('/healthz', (req, res) => res.status(200).send('ok'))

  // Telegram
  app.get('/tg/status', (req, res) => {
    res.send({ telegram: !!tgClient, source: process.env.TELEGRAM_SOURCE || null })
  })

  app.post('/tg/send', async (req, res) => {
    const text = req.body.text || req.query.text
    if (!text) return res.status(400).send({ error: 'text required' })
    if (!tgClient) return res.status(500).send({ error: 'telegram not connected' })
    try {
      await tgClient.sendMessage(process.env.TELEGRAM_SOURCE, { message: String(text) })
      res.send({ status: 'ok', text })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  // WhatsApp status
  app.get('/wa/status', (req,res) => res.send({ ...getWaStatus(), radarActive: !!global.radarActive }))

  app.get('/wa/auth-status', (req,res) => {
    try {
      if (!fs.existsSync(AUTH_DIR)) return res.send({ exists:false, files:[] })
      const files = fs.readdirSync(AUTH_DIR).filter(f => fs.statSync(path.join(AUTH_DIR, f)).isFile())
      res.send({ exists:true, files })
    } catch(e){ res.status(500).send({ error: e?.message || e }) }
  })

  // reset / relogin
  app.post('/wa/reset', async (req,res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error:'forbidden' })
    try {
      if (global.sock) try { await global.sock.logout(); await global.sock.end() } catch(e){}
      try { fs.rmSync(AUTH_DIR, { recursive:true, force:true }); fs.mkdirSync(AUTH_DIR,{recursive:true}) } catch(e){}
      global.lastQR = null; global.cachedGroupJid = null
      startWhatsApp({ reset:true })
      res.send({ status:'ok', message:'reset scheduled' })
    } catch(e){ res.status(500).send({ error: e?.message || e }) }
  })

  app.post('/wa/relogin', async (req,res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error:'forbidden' })
    try {
      if (global.sock) try { await global.sock.logout(); await global.sock.end() } catch(e){}
      try { fs.rmSync(AUTH_DIR, { recursive:true, force:true }); fs.mkdirSync(AUTH_DIR,{recursive:true}) } catch(e){}
      global.lastQR = null; global.cachedGroupJid = null
      startWhatsApp({ reset:true })
      res.send({ status:'ok', message:'relogin scheduled' })
    } catch(e){ res.status(500).send({ error: e?.message || e }) }
  })

  app.get('/wa/relogin-ui', (req,res) => {
    const token = ADMIN_TOKEN
    axios.post(`${UI_DOMAIN}/wa/relogin?token=${token}`).catch(()=>{})
    res.send(`<html><body><p>Relogin requested. Return to <a href="/">main</a>.</p></body></html>`)
  })

  // QR endpoints
  app.get('/wa/qr', async (req,res) => {
    if (!lastQR) return res.status(404).send('QR not generated')
    try {
      const dataUrl = await QRCode.toDataURL(lastQR, { margin:1, width:640 })
      res.setHeader('Content-Type','text/html; charset=utf-8')
      res.send(`<!doctype html><html><body><img src="${dataUrl}"/></body></html>`)
    } catch(e){ res.status(500).send(e?.message || e) }
  })

  app.get('/wa/qr-img', async (req,res) => {
    if (!lastQR) return res.status(404).send('QR not generated')
    try {
      const buf = await QRCode.toBuffer(lastQR, { type:'png', scale:8 })
      res.setHeader('Content-Type','image/png')
      res.setHeader('Cache-Control','no-store, no-cache')
      res.send(buf)
    } catch(e){ res.status(500).send(e?.message || e) }
  })

  app.get('/wa/qr-ascii', (req,res) => {
    if (!lastQR) return res.status(404).send('QR not generated')
    qrcodeTerminal.generate(lastQR, { small:true }, qrcode => {
      res.setHeader('Content-Type','text/plain; charset=utf-8')
      res.send(qrcode)
    })
  })

  // send
  app.post('/wa/send', async (req,res) => {
    const text = req.body.text || req.query.text
    if (!text) return res.status(400).send({ error:'text required' })
    try {
      const ok = await sendToWhatsApp(String(text))
      if (!ok) return res.status(500).send({ error:'send failed' })
      res.send({ status:'ok', text })
    } catch(e){ res.status(500).send({ error:e?.message || e }) }
  })

  app.get('/wa/groups', async (req,res) => {
    if (!global.sock || waConnectionStatus !== 'connected') return res.status(500).send({ error:'whatsapp not connected' })
    try {
      const groups = await global.sock.groupFetchAllParticipating()
      const list = Object.values(groups || {}).map(g=>({id:g.id, name:g.subject}))
      res.send(list)
    } catch(e){ res.status(500).send({ error:e?.message || e }) }
  })

  // radar
  app.post('/wa/radar/on', async (req,res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error:'forbidden' })
    try {
      global.radarActive = true
      infoLog('🔔 Radar turned ON via API')
      if (waConnectionStatus === 'connected') {
        await sendToWhatsApp('[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]')
      }
      res.send({ status:'ok', radarActive:true })
    } catch(e){ res.status(500).send({ error:e?.message || e }) }
  })

  app.post('/wa/radar/off', async (req,res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error:'forbidden' })
    try {
      global.radarActive = false
      infoLog('🔕 Radar turned OFF via API')
      if (waConnectionStatus === 'connected') {
        await sendToWhatsApp('[🔧service🔧]\n[🚨РАДАР отключен🚨]\n[🤚ручной режим🤚]')
      }
      res.send({ status:'ok', radarActive:false })
    } catch(e){ res.status(500).send({ error:e?.message || e }) }
  })

  app.get('/wa/radar/status', (req,res) => {
    res.send({ radarActive: !!global.radarActive })
  })

  // monitoring
  app.get('/wa/recent-forwarded', (req,res) => {
    res.send(recentForwarded.slice().reverse())
  })
  app.get('/wa/recent-messages', (req,res) => {
    res.send(recentWAMessages.slice().reverse())
  })

  // logs
  app.get('/logs', (req,res) => {
    try {
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE,'utf8') : ''
      res.setHeader('Content-Type','text/plain; charset=utf-8')
      res.send(content)
    } catch(e){ res.status(500).send(e?.message || e) }
  })

  app.get('/logs/tail', (req,res) => {
    try {
      const lines = parseInt(req.query.lines || '200',10)
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE,'utf8') : ''
      const arr = content.trim().split('\n').filter(Boolean)
      const tail = arr.slice(-lines).join('\n')
      res.setHeader('Content-Type','text/plain; charset=utf-8')
      res.send(tail)
    } catch(e){ res.status(500).send(e?.message || e) }
  })
}
