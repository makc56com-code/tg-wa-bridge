// ---------------- HTTP ----------------
const app = express(); 
app.use(express.json())

// Вспомогательный endpoint для получения QR как PNG
app.get('/wa/qr-img', async (req, res) => {
  if (!lastQR) return res.status(404).send('QR not generated')
  try {
    const buffer = await QRCode.toBuffer(lastQR, { type: 'png', scale: 8 })
    res.setHeader('Content-Type', 'image/png')
    res.send(buffer)
  } catch (e) {
    error('❌ QR generation error: ' + (e?.message||e))
    res.status(500).send('QR generation failed')
  }
})

// WebUI live QR + кнопка relogin
app.get('/', (req, res) => {
  const html = `<!doctype html><html><head><meta charset="utf-8">
  <title>TG→WA Bridge</title>
  <style>
    body{font-family:sans-serif;background:#0b1220;color:#e6eef8;padding:20px}
    .card{max-width:980px;margin:0 auto;background:#07102a;padding:18px;border-radius:10px}
    a.btn{display:inline-block;margin:6px;padding:10px 14px;border-radius:8px;text-decoration:none;background:#06b6d4;color:#04202a;font-weight:700}
    .qr{margin-top:12px;text-align:center}
  </style>
  </head><body>
  <div class="card">
    <h1>🤖 TG → WA Bridge</h1>
    <div>
      <a class="btn" href="/ping">Ping</a>
      <a class="btn" href="/wa/status">WA Status</a>
      <a class="btn" href="/wa/groups">WA Groups</a>
      <a class="btn" href="/wa/send?text=Hello">Send → WA</a>
      <a class="btn" href="/wa/reset">Reset WA</a>
      <a class="btn" href="/wa/relogin-ui">Relogin WA</a>
    </div>
    <div style="margin-top:12px">WA: <strong>${waConnectionStatus}</strong></div>
    <div class="qr" id="qrbox">
      ${lastQR ? `<img src="/wa/qr-img?ts=${Date.now()}" style="max-width:320px"/>` 
                 : '<div style="color:#9fb0c8">QR not generated</div>'}
    </div>
  </div>
  <script>
    // Live QR refresh
    setInterval(async ()=>{
      try {
        const resp = await fetch('/wa/status')
        const j = await resp.json()
        if(j.qrPending){
          let img = document.querySelector('#qrbox img')
          if(!img) img = document.createElement('img')
          img.src = '/wa/qr-img?ts=' + Date.now()
          img.style.maxWidth = '320px'
          document.getElementById('qrbox').innerHTML = ''
          document.getElementById('qrbox').appendChild(img)
        }
      } catch(e){}
    },2000)
  </script>
  </body></html>`
  res.setHeader('Content-Type','text/html')
  res.send(html)
})
