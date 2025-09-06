// apply_ui_radar_patch.js
// Запуск: node apply_ui_radar_patch.js
// ВНИМАНИЕ: сделай бэкап проекта заранее

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'index.js');

if (!fs.existsSync(FILE)) {
  console.error('index.js не найден в текущей папке:', FILE);
  process.exit(1);
}

// create backup
const bak = FILE + '.bak.' + Date.now();
fs.copyFileSync(FILE, bak);
console.log('Backup created:', bak);

let s = fs.readFileSync(FILE, 'utf8');

// ------------------- 1) Добавляем переменные состояния рядом с radarActive -------------------
if (s.indexOf('let radarTestMode') === -1) {
  s = s.replace(/(let radarActive\s*=.*\n)/, `$1let radarTestMode = false;\nlet lastRadarStateLogSent = null; // 'on'|'off' or null\n`);
  console.log('Inserted radarTestMode + lastRadarStateLogSent.');
} else {
  console.log('radarTestMode already exists — skipped.');
}

// ------------------- 2) Обновляем _sendToWAWrapper чтобы добавлял тест-префикс -------------------
if (s.indexOf('async function _sendToWAWrapper(text)') !== -1) {
  s = s.replace(/async function _sendToWAWrapper\([\s\S]*?\n\}\n\n\/\//, match => {
    // find function body and replace it
    const newFn = `async function _sendToWAWrapper(text) {
  try {
    let finalText = String(text || '');
    // если включён режим тестирования — добавляем сервисный префикс
    if (typeof radarTestMode !== 'undefined' && radarTestMode) {
      finalText = '[🔧service🔧]\\n[🛠режим тестирования🛠]\\n' + finalText;
    }
    if (!sock || waConnectionStatus !== 'connected') { warnLog('⏳ WA не готов — сообщение не отправлено'); return false }
    const jid = cachedGroupJid || (CONFIG_GROUP_ID ? (CONFIG_GROUP_ID.endsWith('@g.us') ? CONFIG_GROUP_ID : CONFIG_GROUP_ID + '@g.us') : null)
    if (!jid) { errorLog('❌ Нет идентификатора группы для отправки'); return false }
    await sock.sendMessage(jid, { text: String(finalText) })
    infoLog('➡️ Отправлено в WA: ' + String(finalText).slice(0, 200))
    recentForwarded.push({ text: String(finalText), ts: Date.now() })
    if (recentForwarded.length > MAX_CACHE) recentForwarded.shift()
    return true
  } catch (e) {
    errorLog('❌ Ошибка отправки в WA: ' + (e?.message || e))
    return false
  }
}

//`;
    return newFn;
  });
  console.log('Updated _sendToWAWrapper to add test-mode prefix.');
} else {
  console.log('Could not find _sendToWAWrapper signature. Skipping that replacement — manual check required.');
}

// ------------------- 3) Добавляем sendServiceMessageToWA helper, если нет -------------------
if (s.indexOf('async function sendServiceMessageToWA') === -1) {
  // place helper near top: after AUTH_DIR creation area (finding appendLogLine function area)
  if (s.indexOf('function appendLogLine') !== -1) {
    s = s.replace(/(function appendLogLine[\s\S]*?\}\n)/, `$1
async function sendServiceMessageToWA(text){
  try {
    // use wrapper so test-mode prefix applies automatically
    await _sendToWAWrapper(String(text));
  } catch(e){
    errorLog('⚠️ sendServiceMessageToWA failed: ' + (e?.message || e));
  }
}

`);
    console.log('Inserted sendServiceMessageToWA helper.');
  } else {
    console.log('Не нашёл место для вставки sendServiceMessageToWA — вставлю в начало файла.');
    s = `async function sendServiceMessageToWA(text){ try{ await _sendToWAWrapper(String(text)); } catch(e){ console.error(e) } }\n` + s;
  }
} else {
  console.log('sendServiceMessageToWA already present — skipped.');
}

// ------------------- 4) Гарантированная отправка service msg при toggle radar -------------------
// Патчим обработчики /wa/radar/on и /wa/radar/off
s = s.replace(/app\.post\('\/wa\/radar\/on'[\s\S]*?res\.send\(\{ status: 'ok', radarActive \}\)\s*\}\)\s*\/\)/, match => {
  // find existing handler code and replace with improved version
  return `app.post('/wa/radar/on', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    const interactive = !!req.body.interactive
    const prev = !!radarActive
    radarActive = true
    infoLog('🔔 Radar turned ON via API')
    try { startWhatsApp({ reset: false }).catch(()=>{}) } catch(e){}
    // send service message only if state changed or if interactive call forces it
    if (lastRadarStateLogSent !== 'on' || interactive) {
      await sendServiceMessageToWA('[🔧service🔧]\\n[🚨РАДАР АКТИВЕН🚨]\\n[🤖автоматический режи🤖]')
      lastRadarStateLogSent = 'on'
    }
    res.send({ status: 'ok', radarActive })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})`;
});

s = s.replace(/app\.post\('\/wa\/radar\/off'[\s\S]*?res\.send\(\{ status: 'ok', radarActive \}\)\s*\}\)\s*\/\)/, match => {
  return `app.post('/wa/radar/off', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    const interactive = !!req.body.interactive
    const prev = !!radarActive
    radarActive = false
    infoLog('🔕 Radar turned OFF via API')
    if (waConnectionStatus === 'connected') {
      if (lastRadarStateLogSent !== 'off' || interactive) {
        await sendServiceMessageToWA('[🔧service🔧]\\n[🚨РАДАР отключен🚨]\\n[🤚ручной режим🤚]')
        lastRadarStateLogSent = 'off'
      }
    } else {
      warnLog('WA not connected — radar-off message not sent to group (will send when connected only if specified).')
    }
    res.send({ status: 'ok', radarActive })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})`;
});

// ------------------- 5) Добавляем endpoints для Radar Test (on/off) -------------------
if (s.indexOf("app.post('/wa/radar/test/on'") === -1) {
  const injectPos = s.lastIndexOf('app.get(\'/wa/relogin-ui\'');
  let inject = `
/* Radar TEST endpoints */
app.post('/wa/radar/test/on', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    radarTestMode = true
    infoLog('🔧 Radar TEST mode: ON')
    await sendServiceMessageToWA('[🔧service🔧]\\n[🛠testON🛠]\\n[🤚ручной режим🤚]')
    res.send({ ok: true, radarTestMode })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})

app.post('/wa/radar/test/off', async (req, res) => {
  const token = req.query.token || req.body.token
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' })
  try {
    radarTestMode = false
    infoLog('🔧 Radar TEST mode: OFF')
    await sendServiceMessageToWA('[🔧service🔧]\\n[🛠testOFF🛠]\\n🤖автоматический режим🤖')
    res.send({ ok: true, radarTestMode })
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
})
`;
  if (injectPos !== -1) {
    s = s.slice(0, injectPos) + inject + s.slice(injectPos);
    console.log('Inserted radar test endpoints near /wa/relogin-ui area.');
  } else {
    s += inject;
    console.log('Appended radar test endpoints to end of file.');
  }
} else {
  console.log('Radar test endpoints already present — skipped.');
}

// ------------------- 6) UI: убрать кнопку "Send → WA" и удалить non-interactive Radar ON/OFF, добавить RadarTest buttons and handlers and password modal -------------------
// remove the focus_sendwa button by id
s = s.replace(/<button[^>]*id=["']focus_sendwa["'][\s\S]*?<\/button>\s*/i, '');
console.log('Removed focus_sendwa button (if present).');

// remove the non-interactive Radar ON/OFF buttons block
s = s.replace(/<button[^>]*id=["']radarOnBtn["'][\s\S]*?<\/button>\s*<button[^>]*id=["']radarOffBtn["'][\s\S]*?<\/button>/i, '');

// inject RadarTest buttons and client handlers before </body> if not present
if (s.indexOf('radarTestOnBtn') === -1) {
  // add two buttons in the small area near Radar toggle: find the toggle-wrap or the closing of that section
  s = s.replace(/(<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/script>)/i, match => {
    // if the file's big, safer to instead inject near where setRadarUi defined
    return match;
  });

  // simpler: add buttons into the UI script region where existing radar handlers exist
  s = s.replace(/(\/\/ RADAR UI handlers[\s\S]*?radarOffBtn\.onclick = async \(\) => {[\s\S]*?}\n\n\s*async function toggleRadar\(on\) {)/, (m) => {
    // Some index.js does not have radarOffBtn.onclick defined; we'll instead append handlers after toggleRadar implementation.
    return m + `\n\n    // Radar TEST buttons\n    const radarTestOnBtn = document.getElementById && document.getElementById('radarTestOnBtn');\n    const radarTestOffBtn = document.getElementById && document.getElementById('radarTestOffBtn');\n    if (!radarTestOnBtn && document.querySelector) {\n      // if buttons not in DOM, insert them next to switch\n      try{\n        const wrap = document.querySelector('.toggle-wrap');\n        if (wrap) {\n          const b1 = document.createElement('button'); b1.className='btn'; b1.id='radarTestOnBtn'; b1.innerText='RadarTest ON';\n          const b2 = document.createElement('button'); b2.className='ghost'; b2.id='radarTestOffBtn'; b2.innerText='RadarTest OFF';\n          wrap.parentNode.insertBefore(b1, wrap.nextSibling);\n          wrap.parentNode.insertBefore(b2, wrap.nextSibling);\n        }\n      }catch(e){}\n    }\n    if (typeof document !== 'undefined'){\n      setTimeout(()=>{\n        const tOn = document.getElementById('radarTestOnBtn');\n        const tOff = document.getElementById('radarTestOffBtn');\n        if(tOn) tOn.addEventListener('click', async ()=>{\n          appendToLogBox('-> RadarTest ON');\n          const r = await callApi('/wa/radar/test/on?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' });\n          appendToLogBox('<- RadarTest ON: ' + JSON.stringify(r.data || r));\n        });\n        if(tOff) tOff.addEventListener('click', async ()=>{\n          appendToLogBox('-> RadarTest OFF');\n          const r = await callApi('/wa/radar/test/off?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' });\n          appendToLogBox('<- RadarTest OFF: ' + JSON.stringify(r.data || r));\n        });\n      }, 400);\n    }\n\n` + '\n';
  });
  console.log('Attempted to inject RadarTest client handlers (if pattern matched).');
} else {
  console.log('radarTestOnBtn already present in UI — skipped injection.');
}

// Also try to directly insert two buttons in HTML near existing toggle area (safer)
s = s.replace(/(<div class="toggle-wrap"[\s\S]*?<\/div>)/i, (m) => {
  if (m.indexOf('radarTestOnBtn') !== -1) return m;
  return m + `\n<div style="display:flex;gap:8px;margin-top:8px">\n  <button class="btn" id="radarTestOnBtn">RadarTest ON</button>\n  <button class="ghost" id="radarTestOffBtn">RadarTest OFF</button>\n</div>`;
});
console.log('Inserted RadarTest buttons in HTML (if toggle-wrap found).');

// ------------------- 7) Добавляем UI password middleware and /ui-login endpoint -------------------
// Insert cookie-parse-less middleware and uiAuth before the main app.get('/') handler.
// We'll locate the line `app.get('/', (req, res) => {` and replace it with `app.get('/', uiAuth, (req,res)=>{`
if (s.indexOf('app.post(\'/ui-login\'') === -1) {
  // insert uiAuth and ui-login handler before the app.get('/') definition
  const insertPoint = s.indexOf("app.get('/', (req, res) =>");
  if (insertPoint !== -1) {
    const authBlock = `
// Simple UI password-only auth (no external library). Uses ADMIN_PASSWORD env.
// Parses cookies manually from req.headers.cookie
function parseCookies(req) {
  const raw = req.headers && req.headers.cookie;
  const out = {};
  if (!raw) return out;
  raw.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx+1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}
function uiAuth(req, res, next) {
  try {
    if (!process.env.ADMIN_PASSWORD) return next(); // if no password set — allow
    const cookies = parseCookies(req);
    if (cookies && cookies.ui_auth === '1') return next();
    // If AJAX request, return 401
    if ((req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest') return res.status(401).send('Unauthorized');
    // else show simple login page
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>UI Login</title></head><body style="font-family:Arial;padding:24px">
<h2>Вход в UI</h2>
<form method="POST" action="/ui-login" id="f">
  <input name="password" type="password" placeholder="Пароль" style="padding:8px;width:300px"/>
  <button type="submit" style="padding:8px 12px">Войти</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', async function(e){
  e.preventDefault();
  const pwd = this.password.value;
  const r = await fetch('/ui-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});
  if (r.ok) { location.href = '/'; } else { alert('Неверный пароль'); }
});
</script>
</body></html>`);
  } catch (e) {
    return res.status(500).send('Error');
  }
}

app.post('/ui-login', express.json(), (req, res) => {
  try {
    const pw = req.body && req.body.password;
    if (!pw) return res.status(400).send({ ok:false });
    if (pw === process.env.ADMIN_PASSWORD) {
      // set cookie for UI access; cookie not secure by default (Render uses https)
      res.setHeader('Set-Cookie', 'ui_auth=1; HttpOnly; Path=/; SameSite=Lax');
      return res.json({ ok:true });
    }
    return res.status(401).json({ ok:false });
  } catch (e) {
    return res.status(500).json({ ok:false });
  }
});
`;
    s = s.slice(0, insertPoint) + authBlock + s.slice(insertPoint);
    // now add uiAuth to the app.get('/') signature (first occurrence)
    s = s.replace("app.get('/', (req, res) =>", "app.get('/', uiAuth, (req, res) =>");
    console.log('Inserted uiAuth middleware and /ui-login endpoint and protected /.');
  } else {
    console.log('Не удалось найти app.get(/) для вставки uiAuth — пропущено (потребуется ручная правка).');
  }
} else {
  console.log('/ui-login already present — skipped UI auth insertion.');
}

// ------------------- 8) Ensure startup sends radar service state once -------------------
// Look for the startup anonymous async block end where startWhatsApp was called earlier
if (s.indexOf('Send service status on startup') === -1) {
  // insert a small block right after await startWhatsApp({ reset: false })
  s = s.replace(/(await startWhatsApp\(\{ reset: false \}\)\s*\)\s*;?\n)/, `$1
  // send radar status on startup (only once)
  (async ()=>{
    try{
      const st = radarActive ? '[🔧service🔧]\\n[🚨РАДАР АКТИВЕН🚨]\\n[🤖автоматический режи🤖]' : '[🔧service🔧]\\n[🚨РАДАР отключен🚨]\\n[🤚ручной режим🤚]';
      if (lastRadarStateLogSent !== (radarActive ? 'on' : 'off')) {
        await sendServiceMessageToWA(st).catch(()=>{});
        lastRadarStateLogSent = radarActive ? 'on' : 'off';
      }
    }catch(e){ errorLog('startup service msg failed: ' + (e?.message||e)); }
  })();

`);
  console.log('Inserted startup radar service status block.');
} else {
  console.log('Startup radar status block already present — skipped.');
}

// ------------------- write back -------------------
fs.writeFileSync(FILE, s, 'utf8');
console.log('Patched index.js saved. Please review the file and test locally before deployment.');
console.log('If something broke — restore from backup:', bak);
