import { UI_DOMAIN, CONFIG_GROUP_ID, CONFIG_GROUP_NAME, ADMIN_TOKEN } from './config.js'
import { waConnectionStatus } from './whatsapp.js'
import { tgClient } from './telegram.js'

export function serveUI(app) {
  app.get('/', (req, res) => {
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
      <div class="mutedbox">UI: ${UI_DOMAIN} · Group: ${CONFIG_GROUP_NAME || CONFIG_GROUP_ID || 'not configured'}</div>
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

    <div class="statusline">WA: <strong id="wastate">${waConnectionStatus}</strong> · Telegram: <strong id="tgstate">${tgClient ? 'connected' : 'disconnected'}</strong></div>

    <div class="panel">
      <div class="col">
        <div><label class="small">Отправить текст в WhatsApp:</label>
        <textarea id="wa_text" placeholder="Текст для отправки..."></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="btn_sendwa">Отправить в WA</button>
          <button class="ghost" id="btn_refresh">Обновить статус</button>
        </div>
        </div>
        <hr style="margin:12px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">
        <div><label class="small">Отправить текст в Telegram:</label>
        <input id="tg_text" type="text" placeholder="Текст в TG..."/>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="btn_tgsend">Отправить в TG</button>
          <button class="ghost" id="btn_showrecent">Показать пересланные</button>
        </div>
        </div>
      </div>

      <div class="col">
        <div><strong>QR</strong>
          <div class="qr" id="qrbox">${ waConnectionStatus === 'awaiting_qr' ? `<img src="/wa/qr-img?ts=${Date.now()}" style="max-width:320px;"/>` : `<div style="color:#9fb0c8">QR not generated</div>` }</div>
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
        <div><strong>Логи / Статус</strong></div>
        <div class="small">Последнее обновление: <span id="lastupd">—</span></div>
      </div>
      <div class="log" id="logbox">загрузка...</div>
    </div>

    <script>
      const ADMIN_TOKEN = ${JSON.stringify(ADMIN_TOKEN || '')};
      function fmtNow(){ return new Date().toLocaleString(); }
      function appendToLogBox(s){
        const box=document.getElementById('logbox')
        const ts='['+fmtNow()+'] '
        box.innerText=ts+s+'\\n\\n'+box.innerText
        if(box.innerText.length>20000) box.innerText=box.innerText.slice(0,20000)
        document.getElementById('lastupd').innerText=fmtNow()
      }
      async function callApi(path, opts={}) {
        const r=await fetch(path, opts)
        const text = await (r.headers.get('content-type')?.includes('application/json') ? r.json().catch(()=>null) : r.text().catch(()=>null))
        return {ok:r.ok,status:r.status,data:text}
      }
      document.getElementById('ping').onclick=async()=>{appendToLogBox('-> ping');const r=await callApi('/ping');appendToLogBox('<- '+JSON.stringify(r.data))}
      document.getElementById('health').onclick=async()=>{const r=await callApi('/healthz');appendToLogBox('<- health: '+(r.ok?'ok':'fail'))}
      document.getElementById('tgstatus').onclick=async()=>{const r=await callApi('/tg/status');appendToLogBox('<- tg: '+JSON.stringify(r.data))}
      document.getElementById('wastatus').onclick=async()=>{const r=await callApi('/wa/status');appendToLogBox('<- wa: '+JSON.stringify(r.data))}
      document.getElementById('btn_sendwa').onclick=async()=>{const raw=document.getElementById('wa_text').value;if(!raw)return;await callApi('/wa/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:raw})});appendToLogBox('-> send WA')}
      document.getElementById('btn_tgsend').onclick=async()=>{const raw=document.getElementById('tg_text').value;if(!raw)return;await callApi('/tg/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:raw})});appendToLogBox('-> send TG')}
      document.getElementById('radarOnBtn').onclick=async()=>{await callApi('/wa/radar/on?token='+ADMIN_TOKEN,{method:'POST'});appendToLogBox('-> radar ON')}
      document.getElementById('radarOffBtn').onclick=async()=>{await callApi('/wa/radar/off?token='+ADMIN_TOKEN,{method:'POST'});appendToLogBox('-> radar OFF')}
    </script>
    </div></body></html>`
    res.setHeader('Content-Type','text/html; charset=utf-8')
    res.send(html)
  })
}
