import express from 'express'
import fs from 'fs'
import path from 'path'
import QRCode from 'qrcode'
import { ADMIN_TOKEN, PORT, UI_DOMAIN } from './config.js'
import { tgClient, startTelegram } from './telegram.js'
import { startWhatsApp, sendToWhatsApp, getWaStatus, getRecentForwarded, getRecentWAMessages, cacheGroupId, setRadar, qrDataUrl } from './whatsapp.js'
import { infoLog, warnLog, errorLog, LOG_FILE } from './logger.js'
import { saveAuthToGist } from './gist.js'

export default function registerRoutes(app) {
  app.get('/ping', (req, res) => res.send('pong'))
  app.get('/healthz', (req, res) => res.status(200).send('ok'))

  app.get('/tg/status', (req, res) => res.send({ telegram: !!tgClient, source: process.env.TELEGRAM_SOURCE || null }))

  app.post('/tg/send', async (req, res) => {
    const text = req.body.text || req.query.text
    if (!text) return res.status(400).send({ error: 'text required' })
    if (!tgClient) return res.status(500).send({ error: 'telegram not connected' })
    try {
      await tgClient.sendMessage(process.env.TELEGRAM_SOURCE, { message: String(text) })
      res.send({ status: 'ok', text })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.get('/wa/status', (req, res) => {
    res.send(getWaStatus())
  })

  app.get('/wa/auth-status', (req, res) => {
    try {
      const dir = process.env.AUTH_DIR
      if (!fs.existsSync(dir)) return res.send({ exists: false, files: [] })
      const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile())
      res.send({ exists: true, files })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.post('/wa/reset', async (req, res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
    try {
      // trigger reset by removing auth and scheduling restart
      try { fs.rmSync(process.env.AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(process.env.AUTH_DIR, { recursive: true }) } catch (e) {}
      res.send({ status: 'ok', message: 'reset requested' })
      // schedule start with reset
      await startWhatsApp({ reset: true })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.post('/wa/relogin', async (req, res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
    try {
      try { fs.rmSync(process.env.AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(process.env.AUTH_DIR, { recursive: true }) } catch (e) {}
      res.send({ status: 'ok', message: 'relogin requested' })
      await startWhatsApp({ reset: true })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.get('/wa/relogin-ui', (req, res) => {
    const token = ADMIN_TOKEN
    // trigger internal relogin using internal route
    fetch(`${UI_DOMAIN}/wa/relogin?token=${token}`, { method: 'POST' }).catch(()=>{})
    res.send(`<html><body><p>Relogin requested. Return to <a href="/">main</a>.</p></body></html>`)
  })

  app.get('/wa/qr', async (req, res) => {
    const dataUrl = await qrDataUrl()
    if (!dataUrl) return res.status(404).send('QR not generated')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(`<!doctype html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#071024"><img src="${dataUrl}" /></body></html>`)
  })

  app.get('/wa/qr-img', async (req, res) => {
    if (!process.env.AUTH_DIR) return res.status(500).send('no auth dir')
    // Use the QR from whatsapp module (via qrDataUrl) — but fallback to 404
    const dataUrl = await qrDataUrl()
    if (!dataUrl) return res.status(404).send('QR not generated')
    // convert dataURL to buffer
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store, no-cache')
    res.send(buf)
  })

  app.get('/wa/qr-ascii', (req, res) => {
    // if we can't generate ascii, return 404
    const lastQR = global.lastQR // not ideal, but ascii primarily for dev use
    if (!lastQR && typeof req.app.locals.lastQR !== 'string') {
      return res.status(404).send('QR not generated')
    }
    const qr = req.app.locals.lastQR || lastQR
    qrcodeTerminal.generate(qr, { small: true }, qrcode => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.send(qrcode)
    })
  })

  app.post('/wa/send', async (req, res) => {
    const text = req.body.text || req.query.text
    if (!text) return res.status(400).send({ error: 'text required' })
    try {
      const ok = await sendToWhatsApp(String(text))
      if (!ok) return res.status(500).send({ error: 'send failed' })
      res.send({ status: 'ok', text })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.get('/wa/groups', async (req, res) => {
    try {
      if (!startWhatsApp) return res.status(500).send({ error: 'not ready' })
      // attempt to fetch groups via sock if connected
      const wa = await import('./whatsapp.js')
      if (!wa.sock || wa.waConnectionStatus !== 'connected') return res.status(500).send({ error: 'whatsapp not connected' })
      const groups = await wa.sock.groupFetchAllParticipating()
      const list = Object.values(groups || {}).map(g => ({ id: g.id, name: g.subject }))
      res.send(list)
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.post('/wa/radar/on', async (req, res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
    try {
      await setRadar(true)
      res.send({ status: 'ok', radarActive: true })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.post('/wa/radar/off', async (req, res) => {
    const token = req.query.token || req.body.token
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
    try {
      await setRadar(false)
      res.send({ status: 'ok', radarActive: false })
    } catch (e) { res.status(500).send({ error: e?.message || e }) }
  })

  app.get('/wa/radar/status', (req, res) => {
    res.send({ radarActive: !!(process.env.RADAR_ACTIVE || true) })
  })

  app.get('/wa/recent-forwarded', (req, res) => {
    res.send(getRecentForwarded())
  })
  app.get('/wa/recent-messages', (req, res) => {
    res.send(getRecentWAMessages())
  })

  app.get('/logs', (req, res) => {
    try {
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.send(content)
    } catch (e) { res.status(500).send(e?.message || e) }
  })

  app.get('/logs/tail', (req, res) => {
    try {
      const lines = parseInt(req.query.lines || '200', 10)
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''
      const arr = content.trim().split('\n').filter(Boolean)
      const tail = arr.slice(-lines).join('\n')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.send(tail)
    } catch (e) { res.status(500).send(e?.message || e) }
  })

  // main UI (kept same as before, minimal changes)
  app.get('/', async (req, res) => {
    const waStatus = getWaStatus()
    const qrImgHtml = waStatus.qrPending ? `<img src="/wa/qr-img?ts=${Date.now()}" style="max-width:320px;"/>` : `<div style="color:#9fb0c8">QR not generated</div>`
    // simple UI - identical to original but trimmed where needed
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>TG→WA Bridge</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
    :root{--bg:#071226;--card:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));--accent:#06b6d4;--muted:#9fb0c8;--btn-text:#04202a}
    body{font-family:Inter,Segoe UI,Roboto,Arial;background:var(--bg);color:#e6eef8;margin:0;padding:18px;display:flex;justify-content:center}
    .card{max-width:980px;width:100%;background:var(--card);border-radius:12px;padding:18px;box-sizing:border-box}
    header{display:flex;justify-content:space-between;align-items:center;gap:12px}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .btn{display:inline-flex;align-items:center;justify-content:center;margin:6px;padding:10px 14px;border-radius:10px;text-decoration:none;background:var(--accent);color:#04202a;font-weight:700;cursor:pointer;border:none}
    .ghost{display:inline-flex;align-items:center;justify-content:center;margin:6px;padding:10px 14px;border-radius:10px;text-decoration:none;background:var(--accent);color:#04202a;font-weight:700;cursor:pointer;border:none}
    .qr{margin-top:12px}
    .statusline{margin-top:12px;color:var(--muted)}
    .panel{display:grid;grid-template-columns:1fr 360px;gap:12px;margin-top:12px}
    .panel .col{background:rgba(0,0,0,0.12);padding:12px;border-radius:8px;min-height:120px}
    textarea{width:100%;height:90px;border-radius:8px;padding:8px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit;resize:vertical}
    input[type=text]{width:100%;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit}
    .small{font-size:13px;color:var(--muted)}
    .list{max-height:220px;overflow:auto;padding:6px}
    .log{white-space:pre-wrap;font-family:monospace;font-size:12px;color:#cfeefb;max-height:420px;overflow:auto;padding:8px;background:rgba(0,0,0,0.08);border-radius:6px}
    .full-logs{margin-top:12px}
    .mutedbox{color:var(--muted);font-size:13px}
    #statustxt { max-height:140px; overflow:auto; word-break:break-word; white-space:pre-wrap; color:var(--muted); font-size:13px; margin-top:6px; border-radius:6px; padding:6px; background:rgba(0,0,0,0.04); }
    .toggle-wrap{display:flex;align-items:center;gap:10px;margin-top:8px}
    .switch{position:relative;width:56px;height:30px;border-radius:20px;background:rgba(255,255,255,0.06);cursor:pointer;display:inline-block}
    .switch .knob{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:left .18s ease}
    .switch.on{background:linear-gradient(90deg,#06b6d4,#0ea5a4)}
    .switch.on .knob{left:29px}
    @media(max-width:900px){ .panel{grid-template-columns:1fr} .btn{flex:1 1 auto} .ghost{flex:1 1 auto} }
    </style>
    </head><body><div class="card">
    <header>
      <h1 style="margin:0">🤖 TG → WA Bridge</h1>
      <div class="mutedbox">UI: ${UI_DOMAIN} · Group: ${process.env.WA_GROUP_NAME || process.env.WA_GROUP_ID || 'not configured'}</div>
    </header>

    <div class="row" style="margin-top:8px">
      <button class="btn" id="ping">Ping</button>
      <button class="btn" id="health">Health</button>
      <button class="btn" id="tgstatus">TG Status</button>
      <button class="btn" id="wastatus">WA Status</button>
      <button class="btn" id="wagroups">WA Groups</button>
      <button class="btn" id="focus_sendwa">Send → WA</button>
      <button class="btn" id="resetwa">Reset WA</button>
      <button class="btn" id="reloginwa">Relogin WA</button>
      <button class="ghost" id="qrascii">QR ASCII</button>
      <button class="ghost" id="logsbtn">Logs</button>
    </div>

    <div class="statusline">WA: <strong id="wastate">${getWaStatus().whatsapp}</strong> · Telegram: <strong id="tgstate">${tgClient ? 'connected' : 'disconnected'}</strong></div>

    <div class="panel">
      <div class="col">
        <div><label class="small">Отправить текст в WhatsApp (в выбранную группу):</label>
        <textarea id="wa_text" placeholder="Текст для отправки..."></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="btn_sendwa">Отправить в WA</button>
          <button class="ghost" id="btn_refresh">Обновить статус</button>
        </div>
        </div>

        <hr style="margin:12px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">

        <div><label class="small">Отправить текст в Telegram (источник):</label>
        <input id="tg_text" type="text" placeholder="Текст в TG..."/>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="btn_tgsend">Отправить в TG</button>
          <button class="ghost" id="btn_showrecent">Показать последние пересланные</button>
        </div>
        </div>
      </div>

      <div class="col">
        <div><strong>QR</strong>
          <div class="qr" id="qrbox">${qrImgHtml}</div>
          <div class="small">QR автоматически обновляется — если появится, отсканируй в WhatsApp</div>
        </div>

        <hr style="margin:10px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">

        <div><strong>Краткий статус</strong>
          <div id="statustxt">...</div>

          <div class="toggle-wrap">
            <div id="radarSwitch" class="switch" title="Toggle Radar"><div class="knob"></div></div>
            <div>
              <div style="font-weight:700" id="radarLabel">RADAR</div>
              <div class="small" id="radarSub">загрузка...</div>
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn" id="radarOnBtn">Radar ON</button>
            <button class="ghost" id="radarOffBtn">Radar OFF</button>
          </div>

        </div>
      </div>
    </div>

    <div class="full-logs">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>Логи / Статус</strong><span style="margin-left:8px;color:var(--muted)">(включая результат кнопок)</span></div>
        <div class="small">Последнее обновление: <span id="lastupd">—</span></div>
      </div>
      <div class="log" id="logbox">загрузка логов...</div>
    </div>

    <script>
      const ADMIN_TOKEN = ${JSON.stringify(ADMIN_TOKEN || '')};
      function fmtNow() { return new Date().toLocaleString(); }
      function appendToLogBox(s) {
        try { const box = document.getElementById('logbox'); const ts = '[' + fmtNow() + '] '; box.innerText = ts + s + '\\n\\n' + box.innerText; if (box.innerText.length > 20000) box.innerText = box.innerText.slice(0, 20000) } catch(e){}
        document.getElementById('lastupd').innerText = fmtNow()
      }

      async function callApi(path, opts = {}) {
        const res = await fetch(path, opts)
        const text = await (res.headers.get('content-type') && res.headers.get('content-type').includes('application/json') ? res.json().catch(()=>null) : res.text().catch(()=>null))
        return { ok: res.ok, status: res.status, data: text }
      }

      document.getElementById('ping').onclick = async () => { appendToLogBox('-> ping ...'); try { const r = await callApi('/ping'); appendToLogBox('<- ping: ' + (r.ok ? String(r.data) : 'HTTP ' + r.status)) } catch (e) { appendToLogBox('! ping error: ' + e.message) } }
      document.getElementById('health').onclick = async () => { appendToLogBox('-> health ...'); try { const r = await callApi('/healthz'); appendToLogBox('<- health: ' + (r.ok ? 'ok' : 'HTTP ' + r.status)) } catch (e) { appendToLogBox('! health error: ' + e.message) } }
      document.getElementById('tgstatus').onclick = async () => { appendToLogBox('-> tg status ...'); try { const r = await callApi('/tg/status'); appendToLogBox('<- tg status: ' + JSON.stringify(r.data)) } catch (e) { appendToLogBox('! tg status error: ' + e.message) } }
      document.getElementById('wastatus').onclick = async () => { appendToLogBox('-> wa status ...'); try { const r = await callApi('/wa/status'); appendToLogBox('<- wa status: ' + JSON.stringify(r.data)); if (r.data && r.data.qrPending) { const box = document.getElementById('qrbox'); let img = box.querySelector('img'); if(!img){ img = document.createElement('img'); img.style.maxWidth='320px'; box.innerHTML=''; box.appendChild(img) } img.src = '/wa/qr-img?ts=' + Date.now() } document.getElementById('wastate').innerText = r.data.whatsapp; document.getElementById('statustxt').innerText = JSON.stringify(r.data); setRadarUi(!!r.data.radarActive) } catch (e) { appendToLogBox('! wa status error: ' + e.message) } }
      document.getElementById('wagroups').onclick = async () => { appendToLogBox('-> wa groups ...'); try { const r = await callApi('/wa/groups'); if (!r.ok) appendToLogBox('<- wa groups error: HTTP ' + r.status + ' ' + JSON.stringify(r.data)); else appendToLogBox('<- wa groups: ' + JSON.stringify(r.data)) } catch (e) { appendToLogBox('! wa groups error: ' + e.message) } }
      document.getElementById('focus_sendwa').onclick = () => { document.getElementById('wa_text').focus(); appendToLogBox('-> focus to WA send box') }
      document.getElementById('resetwa').onclick = async () => { if (!confirm('Сбросить WA сессию? (требуется ADMIN_TOKEN)')) return; appendToLogBox('-> reset WA requested'); try { const r = await callApi('/wa/reset?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' }); appendToLogBox('<- reset: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data))) } catch (e) { appendToLogBox('! reset error: ' + e.message) } }
      document.getElementById('reloginwa').onclick = async () => { if (!confirm('Релогин WA (новая авторизация — QR) — продолжить?')) return; appendToLogBox('-> relogin WA requested'); try { const r = await callApi('/wa/relogin-ui'); appendToLogBox('<- relogin-ui: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status)) } catch (e) { appendToLogBox('! relogin error: ' + e.message) } }
      document.getElementById('qrascii').onclick = async () => { appendToLogBox('-> open QR ASCII'); window.open('/wa/qr-ascii', '_blank'); appendToLogBox('<- QR ASCII opened in new tab') }
      document.getElementById('logsbtn').onclick = async () => { appendToLogBox('-> load server logs tail'); try { const r = await fetch('/logs/tail?lines=400'); const txt = await r.text(); document.getElementById('logbox').innerText = txt || 'пусто'; appendToLogBox('<- logs loaded (' + (txt.length) + ' bytes)') } catch (e) { appendToLogBox('! load logs error: ' + e.message) } }

      document.getElementById('btn_sendwa').onclick = async () => {
        const raw = document.getElementById('wa_text').value
        if(!raw || !raw.trim()) { alert('Введите текст'); return }
        const wrapped = \`[🔧service🔧]\\n[Сообщение: \${raw}]\`
        appendToLogBox('-> send to WA: ' + wrapped.slice(0,200))
        try {
          const r = await callApi('/wa/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: wrapped }) })
          appendToLogBox('<- send WA result: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data)))
          if (r.ok) { alert('Отправлено'); document.getElementById('wa_text').value = '' }
        } catch (e) { appendToLogBox('! send WA error: ' + e.message) }
      }

      document.getElementById('btn_tgsend').onclick = async () => {
        const raw = document.getElementById('tg_text').value
        if(!raw || !raw.trim()) { alert('Введите текст'); return }
        const wrapped = \`[🔧service🔧]\\n[Сообщение: \${raw}]\`
        appendToLogBox('-> send to TG: ' + wrapped.slice(0,200))
        try {
          const r = await callApi('/tg/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: wrapped }) })
          appendToLogBox('<- send TG result: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status + ' ' + JSON.stringify(r.data)))
          if (r.ok) { alert('Отправлено в TG'); document.getElementById('tg_text').value = '' }
        } catch (e) { appendToLogBox('! send TG error: ' + e.message) }
      }

      document.getElementById('btn_showrecent').onclick = async ()=> {
        appendToLogBox('-> show recent forwarded (WA)')
        try { const r = await callApi('/wa/recent-forwarded'); appendToLogBox('<- recent forwarded: ' + JSON.stringify(r.data || [])); document.getElementById('logbox').innerText = (r.data || []).map(x=> (new Date(x.ts)).toLocaleString() + ' → ' + x.text).join('\\n\\n') || 'пусто' } catch(e){ appendToLogBox('! recent-forwarded error: ' + e.message) }
      }

      document.getElementById('btn_refresh').onclick = async () => { appendToLogBox('-> manual refresh status'); await loadStatus(true) }

      const radarSwitch = document.getElementById('radarSwitch')
      const radarLabel = document.getElementById('radarLabel')
      const radarSub = document.getElementById('radarSub')
      const radarOnBtn = document.getElementById('radarOnBtn')
      const radarOffBtn = document.getElementById('radarOffBtn')
      let lastRadarUiState = null
      function setRadarUi(isOn, verbose = false) {
        if (isOn) { radarSwitch.classList.add('on'); radarLabel.innerText = 'RADAR — ON'; radarSub.innerText = 'Автоматическая отправка активна' }
        else { radarSwitch.classList.remove('on'); radarLabel.innerText = 'RADAR — OFF'; radarSub.innerText = 'Ручной режим' }
        if (lastRadarUiState !== isOn) { appendToLogBox('ℹ️ Radar UI: ' + (isOn ? 'ON' : 'OFF')); lastRadarUiState = isOn } else if (verbose) { document.getElementById('statustxt').innerText = (isOn ? 'RADAR: ON' : 'RADAR: OFF') }
      }

      radarSwitch.onclick = async () => { const currentlyOn = radarSwitch.classList.contains('on'); if (currentlyOn) { await toggleRadar(false) } else { await toggleRadar(true) } }
      radarOnBtn.onclick = async () => { await toggleRadar(true) }
      radarOffBtn.onclick = async () => { await toggleRadar(false) }

      async function toggleRadar(on) {
        appendToLogBox('-> toggle radar -> ' + (on ? 'ON' : 'OFF'))
        try {
          const url = on ? '/wa/radar/on' : '/wa/radar/off'
          const r = await callApi(url + '?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' })
          if (!r.ok) { appendToLogBox('<- radar toggle error: HTTP ' + r.status + ' ' + JSON.stringify(r.data)) }
          else { appendToLogBox('<- radar toggled: ' + JSON.stringify(r.data)); setRadarUi(!!(r.data && r.data.radarActive)) }
        } catch (e) { appendToLogBox('! radar toggle error: ' + e.message) }
      }

      async function loadStatus(forceLogs=false) {
        try {
          const s = await callApi('/wa/status')
          document.getElementById('wastate').innerText = s.data.whatsapp
          const t = await callApi('/tg/status')
          document.getElementById('tgstate').innerText = t.data && t.data.telegram ? 'connected' : 'disconnected'
          document.getElementById('statustxt').innerText = JSON.stringify(s.data)
          if (s.data && s.data.qrPending){
            const box = document.getElementById('qrbox')
            let img = box.querySelector('img')
            if(!img){ img = document.createElement('img'); img.style.maxWidth='320px'; box.innerHTML=''; box.appendChild(img) }
            img.src = '/wa/qr-img?ts=' + Date.now()
            appendToLogBox('QR pending — image refreshed')
          }
          setRadarUi(!!(s.data && s.data.radarActive))
          if (forceLogs) {
            try {
              const r = await fetch('/logs/tail?lines=120')
              const logs = await r.text()
              document.getElementById('logbox').innerText = logs || 'пусто'
              appendToLogBox('Logs updated (manual)')
            } catch (e) { appendToLogBox('! logs fetch error: ' + e.message) }
          }
        } catch(e) {
          appendToLogBox('! loadStatus error: ' + (e.message || e))
        }
      }

      setInterval(() => loadStatus(false), 5000)
      loadStatus(true)
    </script>

    </div></body></html>`
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  })
}
