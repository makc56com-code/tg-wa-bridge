/**
 * apply_patch.js
 * Патчер для index.js (TG→WA bridge)
 *
 * Usage:
 * 1) Place this file in project root (рядом с index.js)
 * 2) node apply_patch.js
 *
 * Создаёт бэкап index.js.bak.<ts> и вносит правки.
 */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.js');
if (!fs.existsSync(file)) {
  console.error('ERROR: index.js not found in this folder. Put apply_patch.js into the project root where index.js exists.');
  process.exit(1);
}

const orig = fs.readFileSync(file, 'utf8');
const backupPath = file + '.bak.' + Date.now();
fs.writeFileSync(backupPath, orig, 'utf8');
console.log('Backup created:', backupPath);

let s = orig;

// safety marker to avoid double-insert
if (s.includes('// UI_PATCH_MARKER_v1')) {
  console.log('Patch already applied (marker found). Exiting without changes.');
  process.exit(0);
}

// 1) Insert globals: radarTestMode, pendingServiceMessages, lastRadarStateLogSent, sendServiceMessageToWA
if (!/let radarTestMode\s*=/.test(s)) {
  s = s.replace(/(let radarActive\s*=\s*true)/, `$1

// UI_PATCH_MARKER_v1
// radar test & service message helpers (inserted by patch)
let radarTestMode = false;
let pendingServiceMessages = [];
let lastRadarStateLogSent = null;

async function sendServiceMessageToWA(text){
  // unified service message sender — will try immediate send, otherwise queue
  try {
    if (typeof _sendToWAWrapper === 'function') {
      // try immediate send; _sendToWAWrapper will queue on failure
      await _sendToWAWrapper(String(text));
    } else {
      console.log('[SERVICE->WA]', text);
      pendingServiceMessages.push(String(text));
    }
  } catch(e){
    console.error('sendServiceMessageToWA error', e);
    try{ pendingServiceMessages.push(String(text)) }catch(e2){}
  }
}

`);
  console.log('Inserted radarTestMode/sendServiceMessageToWA globals.');
}

// 2) Replace _sendToWAWrapper implementation to support:
//    - queuing when WA disconnected
//    - sending a separate test-mode service message before the real message (if radarTestMode)
const wrapperStart = 'async function _sendToWAWrapper(text) {';
if (s.includes(wrapperStart) && !s.includes('/* patched_send_wrapper_v1 */')) {
  // find function start index
  const idx = s.indexOf(wrapperStart);
  // find end of function by matching braces
  let i = idx;
  let braceCount = 0;
  let started = false;
  for (; i < s.length; i++) {
    if (s[i] === '{') { braceCount++; started = true; }
    else if (s[i] === '}') braceCount--;
    if (started && braceCount === 0) { i++; break; }
  }
  const origFunc = s.slice(idx, i);
  const newFunc = `/* patched_send_wrapper_v1 */
async function _sendToWAWrapper(text) {
  try {
    // if not connected — queue message for later and return false
    if (!sock || waConnectionStatus !== 'connected') {
      warnLog('⏳ WA не готов — сообщение поставлено в очередь');
      try { pendingServiceMessages.push(String(text)); } catch(e){}
      return false;
    }
    const jid = cachedGroupJid || (CONFIG_GROUP_ID ? (CONFIG_GROUP_ID.endsWith('@g.us') ? CONFIG_GROUP_ID : CONFIG_GROUP_ID + '@g.us') : null);
    if (!jid) { errorLog('❌ Нет идентификатора группы для отправки'); return false; }

    // If test mode active, send a separate test-mode service message before each forwarded message
    if (radarTestMode) {
      try {
        await sock.sendMessage(jid, { text: '[🔧service🔧]\\n[🛠режим тестирования🛠]' });
        infoLog('➡️ Отправлено тестовое уведомление (перед сообщением)');
      } catch(e) {
        warnLog('⚠️ Не удалось отправить тестовое уведомление — будет поставлено в очередь');
        try { pendingServiceMessages.push('[🔧service🔧]\\n[🛠режим тестирования🛠]'); } catch(e2){}
      }
    }

    // send the actual message
    await sock.sendMessage(jid, { text: String(text) });
    infoLog('➡️ Отправлено в WA: ' + String(text).slice(0, 200));
    recentForwarded.push({ text: String(text), ts: Date.now() });
    if (recentForwarded.length > MAX_CACHE) recentForwarded.shift();
    return true;
  } catch (e) {
    errorLog('❌ Ошибка отправки в WA: ' + (e?.message || e));
    try { pendingServiceMessages.push(String(text)); } catch(e){}
    return false;
  }
}
`;
  s = s.slice(0, idx) + newFunc + s.slice(i);
  console.log('Replaced _sendToWAWrapper with patched version (v1).');
}

// 3) On connection open, flush pendingServiceMessages (insert after cacheGroupId(...) call)
if (!s.includes('/* flush_pending_service_messages_v1 */')) {
  s = s.replace(/(try\s*\{\s*await\s+cacheGroupId\([^\)]*\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*warnLog\([^\}]*\}\s*\))/, `$1

    /* flush_pending_service_messages_v1 */
    try {
      if (Array.isArray(pendingServiceMessages) && pendingServiceMessages.length) {
        infoLog('ℹ️ Flushing queued service messages (' + pendingServiceMessages.length + ') after WA connected');
        for (const msg of pendingServiceMessages.slice()) {
          try { await _sendToWAWrapper(msg); } catch(e) { warnLog('⚠️ flush send error: ' + (e?.message||e)) }
        }
        pendingServiceMessages.length = 0;
      }
    } catch(e){ warnLog('⚠️ flush pending messages failed: ' + (e?.message||e)) }
`);
  console.log('Inserted code to flush queued service messages on WA connect.');
}

// 4) Add endpoints /wa/radar-test/on and /wa/radar-test/off near radar endpoints
if (!s.includes('/wa/radar-test/on')) {
  s = s.replace(/(\/\/ RADAR endpoints[\s\S]*?app\.post\('\/wa\/radar\/off'[\s\S]*?\}\)\n\napp\.get\('\/wa\/radar\/status',)/, (m, g1, g2) => {
    // build insertion
    const insert = `// Radar test endpoints
app.post('/wa/radar-test/on', async (req, res) => {
  const token = req.query.token || req.body.token;
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' });
  try {
    radarTestMode = true;
    infoLog('🔧 Radar TEST turned ON via API');
    // immediate service message (or queued)
    await sendServiceMessageToWA('[🔧service🔧]\\n[🛠testON🛠]\\n[🤚ручной режим🤚]');
    res.send({ status: 'ok', radarTestMode });
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
});

app.post('/wa/radar-test/off', async (req, res) => {
  const token = req.query.token || req.body.token;
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(403).send({ error: 'forbidden' });
  try {
    radarTestMode = false;
    infoLog('🔧 Radar TEST turned OFF via API');
    await sendServiceMessageToWA('[🔧service🔧]\\n[🛠testOFF🛠]\\n🤖автоматический режим🤖');
    res.send({ status: 'ok', radarTestMode });
  } catch (e) { res.status(500).send({ error: e?.message || e }) }
});

`;
    return m + insert + g2;
  });
  console.log('Inserted radar-test endpoints.');
}

// 5) Modify UI HTML
// 5a) remove top "Send → WA" button (id="focus_sendwa")
if (s.includes('id="focus_sendwa"')) {
  s = s.replace(/\s*<button[^>]*id=["']focus_sendwa["'][^>]*>[\s\S]*?<\/button>/i, '');
  console.log('Removed Send → WA button from HTML.');
}

// 5b) replace Radar ON/OFF buttons block with RadarTest buttons
const radarBtnsPattern = /<div style="display:flex;gap:8px;margin-top:8px">\s*<button[^>]*id=["']radarOnBtn["'][\s\S]*?<\/div>/i;
if (radarBtnsPattern.test(s)) {
  s = s.replace(radarBtnsPattern, `<div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="radarTestOnBtn">RadarTest ON</button>
          <button class="ghost" id="radarTestOffBtn">RadarTest OFF</button>
        </div>`);
  console.log('Replaced Radar ON/OFF HTML block with RadarTest buttons.');
}

// 6) JS: remove focus_sendwa handler (if any)
s = s.replace(/document\.getElementById\(['"]focus_sendwa['"]\)\.onclick\s*=\s*[^;]+;?/g, '');
console.log('Removed focus_sendwa JS handler (if existed).');

// 7) Make handlers for radarOnBtn/radarOffBtn safe (existence checks) & add RadarTest handlers
if (!s.includes('radarTestOnBtn')) {
  s = s.replace(/const\s+radarOnBtn\s*=\s*document\.getElementById\(['"]radarOnBtn['"]\)\s*;\s*const\s+radarOffBtn\s*=\s*document\.getElementById\(['"]radarOffBtn['"]\)\s*;\s*/s,
    `const radarOnBtn = document.getElementById('radarOnBtn');
    const radarOffBtn = document.getElementById('radarOffBtn');
    if (radarOnBtn) radarOnBtn.onclick = async () => { await toggleRadar(true) }
    if (radarOffBtn) radarOffBtn.onclick = async () => { await toggleRadar(false) }

    const radarTestOnBtn = document.getElementById('radarTestOnBtn');
    const radarTestOffBtn = document.getElementById('radarTestOffBtn');
    if (radarTestOnBtn) {
      radarTestOnBtn.onclick = async () => {
        appendToLogBox('-> RadarTest ON');
        try {
          const r = await callApi('/wa/radar-test/on?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' });
          appendToLogBox('<- radar-test-on: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status));
        } catch(e){ appendToLogBox('! radar-test-on error: ' + e.message) }
      };
    }
    if (radarTestOffBtn) {
      radarTestOffBtn.onclick = async () => {
        appendToLogBox('-> RadarTest OFF');
        try {
          const r = await callApi('/wa/radar-test/off?token=' + encodeURIComponent(ADMIN_TOKEN), { method: 'POST' });
          appendToLogBox('<- radar-test-off: ' + (r.ok ? JSON.stringify(r.data) : 'HTTP ' + r.status));
        } catch(e){ appendToLogBox('! radar-test-off error: ' + e.message) }
      };
    }
`);
  console.log('Added safe handlers for radarOn/Off and added RadarTest handlers in UI JS.');
}

// 8) Add UI password middleware: insert a small route before existing app.get('/', ...) by replacing the first occurrence of "app.get('/', (req, res) => {"
if (s.includes("app.get('/', (req, res) => {") && !s.includes('/* ui_password_middleware_v1 */')) {
  s = s.replace("app.get('/', (req, res) => {", `/* ui_password_middleware_v1 */
app.post('/ui-login', express.json(), (req, res) => {
  try {
    const pw = (req.body && req.body.password) ? String(req.body.password) : '';
    if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD not set on server' });
    if (pw === process.env.ADMIN_PASSWORD) {
      // set cookie (not httpOnly so frontend can set/reload); Path=/ to allow access
      res.setHeader('Set-Cookie', 'ui_pw=' + encodeURIComponent(pw) + '; Path=/; SameSite=Lax');
      return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false });
  } catch (e) { return res.status(500).json({ ok: false, error: e?.message || e }) }
});

app.get('/', (req, res, next) => {
  try {
    const pw = process.env.ADMIN_PASSWORD;
    if (pw) {
      const cookies = req.headers.cookie || '';
      const match = cookies.split(';').map(s=>s.trim()).find(s => s.startsWith('ui_pw='));
      const cookieVal = match ? decodeURIComponent(match.split('=')[1] || '') : null;
      if (cookieVal !== pw) {
        // render simple login page if not authorized
        return res.send(\`<!doctype html><html><head><meta charset="utf-8"><title>Login</title></head><body style="font-family:Arial;padding:20px"><h3>Вход в UI</h3><input id="pwd" type="password" placeholder="Пароль" style="padding:8px" /><button id="btn">Войти</button><div id="err" style="color:red;display:none;margin-top:8px">Неверный пароль</div><script>
document.getElementById('btn').addEventListener('click', async ()=>{ const pw=document.getElementById('pwd').value; try{ const r=await fetch('/ui-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})}); if (r.ok) location.reload(); else { document.getElementById('err').style.display='block' } } catch(e){ document.getElementById('err').style.display='block' } });
</script></body></html>\`);
      }
    }
  } catch(e){}
  next();
});

app.get('/', (req, res) => {`);
  console.log('Inserted UI password middleware and /ui-login endpoint (login via ADMIN_PASSWORD env).');
}

// 9) final marker
if (!s.includes('// UI_PATCH_MARKER_v1_END')) {
  // append closing marker near end (just for safety)
  s = s.replace(/\)\n\s*app\.listen\(/, `)\n// UI_PATCH_MARKER_v1_END\napp.listen(`);
}

// write file
fs.writeFileSync(file, s, 'utf8');
console.log('Patched index.js written. Please inspect and commit. If something went wrong, restore from backup:', backupPath);
