// apply_patches.js
// Node.js script: делает бэкап и правки index.js и webui
// Запуск: node apply_patches.js
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const filesToPatch = [
  'index.js',
  'public/index.html',
  'public/app.js' // или как у тебя файл называется
];

function backup(file){
  if (!fs.existsSync(file)) return;
  const b = file + '.bak.' + Date.now();
  fs.copyFileSync(file, b);
  console.log('backup:', file, '->', b);
}

function replaceInFile(file, pattern, replacement){
  if (!fs.existsSync(file)) {
    console.warn('file not found:', file);
    return false;
  }
  const txt = fs.readFileSync(file, 'utf8');
  const out = txt.replace(pattern, replacement);
  if (out === txt) {
    console.log('no change for', file);
    return false;
  }
  backup(file);
  fs.writeFileSync(file, out, 'utf8');
  console.log('patched', file);
  return true;
}

/* ===== PATCHEs START ===== */

/* 1) index.js:
   - add radar/test flags near top
   - add sendServiceMessageToWA function
   - send service message on startup
   - add endpoints for toggles or socket handlers
   - add ui password middleware
*/

const indexFile = path.join(root, 'index.js');
if (fs.existsSync(indexFile)){
  backup(indexFile);
  let code = fs.readFileSync(indexFile, 'utf8');

  // 1. insert state vars after top imports (heuristic: after first "const app = express()" or after imports)
  if (!/let radarActive/.test(code)){
    code = code.replace(/(const app\s*=\s*express\(\);?)/, `$1

// Bridge states
let radarActive = false;
let radarTestMode = false;
let lastRadarStateLogSent = null; // "on" | "off" | null

// send unified service message (use your sendToWhatsApp or existing function)
async function sendServiceMessageToWA(text){
  try {
    // adapt to your sendToWhatsApp(groupId, text) naming
    if (typeof sendToWhatsApp === 'function') {
      await sendToWhatsApp(process.env.WHATSAPP_GROUP_NAME || process.env.WHATSAPP_GROUP_ID, text);
    } else {
      console.log('[SERVICE -> WA]', text);
    }
  } catch(e){
    console.error('service message error', e);
  }
}

`);
  }

  // 2. ensure on startup we send radar state service message (inject after server start / after session load)
  if (!/sendServiceMessageToWA\(\s*`?\[🔧service🔧\] `/.test(code)){
    // Heuristic: find "app.listen" or "start" function
    code = code.replace(/(app\.listen\([^)]*\)\s*;?)/, `

/* Send service status on startup (RADAR state) */
(async ()=>{
  try{
    const st = radarActive ? '[🔧service🔧]\\n[Radar ON]' : '[🔧service🔧]\\n[Radar OFF]';
    if (lastRadarStateLogSent !== (radarActive ? 'on' : 'off')){
      await sendServiceMessageToWA(st);
      lastRadarStateLogSent = radarActive ? 'on' : 'off';
    }
  }catch(e){ console.error('startup service msg failed', e); }
})();

$1`);
  }

  // 3. add HTTP endpoints for toggles (if you use socket.io, adapt; these endpoints provide fallback)
  if (!/\/toggle-radar/.test(code)){
    code = code.replace(/(app\.use\(express\.static\([^)]*\)\);?)/, `$1

// UI password-only login endpoint
app.post('/ui-login', express.json(), (req,res)=>{
  const pw = req.body && req.body.password;
  if (!pw) return res.status(400).json({ok:false});
  if (pw === process.env.ADMIN_PASSWORD) {
    res.cookie('ui_auth','1',{ httpOnly:true, sameSite: 'lax' });
    return res.json({ok:true});
  }
  return res.status(401).json({ok:false});
});

// endpoints to toggle radar and radar test (called from client)
app.post('/toggle-radar', express.json(), async (req,res)=>{
  const interactive = !!req.body.interactive;
  radarActive = !!req.body.enable;
  const state = radarActive ? 'on' : 'off';
  // send only once if state changed or interactive forced
  if (lastRadarStateLogSent !== state || interactive) {
    const msg = radarActive
      ? '[🔧service🔧]\\n[Radar ACTIVATED]'
      : '[🔧service🔧]\\n[Radar DEACTIVATED]';
    await sendServiceMessageToWA(msg);
    lastRadarStateLogSent = state;
  }
  res.json({ok:true, radarActive});
});

app.post('/toggle-radar-test', express.json(), async (req,res)=>{
  const enable = !!req.body.enable;
  const interactive = !!req.body.interactive;
  radarTestMode = enable;
  if (enable){
    await sendServiceMessageToWA('[🔧service🔧]\\n[🛠testON🛠]\\n[🤚ручной режим🤚]');
  } else {
    await sendServiceMessageToWA('[🔧service🔧]\\n[🛠testOFF🛠]\\n🤖автоматический режим🤖');
  }
  res.json({ok:true, radarTestMode});
});

`);
  }

  // 4. patch forwarding function to add test prefix if radarTestMode
  // Heuristic: find function that forwards messages to WA: sendToWhatsApp(...) or forwardToWa
  if (/function\s+sendToWhatsApp|const\s+sendToWhatsApp\s*=/.test(code) || /sendToWhatsApp\(/.test(code)){
    // naive injection: wrap existing sendToWhatsApp calls in a helper if exists; else add helper
    // We'll add a wrapper function near top:
    if (!/async function _sendToWAWrapper/.test(code)){
      code = code.replace(/(let radarActive = false;)/, `$1

// wrapper to enforce test-mode prefix
async function _sendToWAWrapper(target, text){
  let finalText = text;
  if (radarTestMode) {
    finalText = '[🔧service🔧]\\n[🛠режим тестирования🛠]\\n' + text;
  }
  if (typeof sendToWhatsApp === 'function') {
    return sendToWhatsApp(target, finalText);
  } else {
    console.log('[WA SEND]', target, finalText);
  }
}
`);
      // And replace common sendToWhatsApp( ... ) with _sendToWAWrapper(...)
      code = code.replace(/sendToWhatsApp\s*\(/g, '_sendToWAWrapper(');
    }
  }

  fs.writeFileSync(indexFile, code, 'utf8');
  console.log('index.js patched.');
} else {
  console.warn('index.js not found in project root; skipping index patch');
}

/* 2) WebUI patches: remove Send->WA button, add toggle buttons and password prompt
   We'll patch public/index.html and public/app.js (if present). */

const htmlFile = path.join(root, 'public', 'index.html');
if (fs.existsSync(htmlFile)){
  backup(htmlFile);
  let h = fs.readFileSync(htmlFile, 'utf8');
  // Remove Send -> WA button by id or text
  h = h.replace(/<button[^>]*id=["']?sendToWaBtn["']?[^>]*>[\s\S]*?<\/button>/i, '');
  h = h.replace(/Send\s*-\s*&rarr;\s*WA/i, ''); // general text removal

  // Add password modal (simple) before closing body
  if (!/id=["']uiPasswordModal["']/.test(h)){
    const modal = `
<!-- UI Password prompt -->
<div id="uiPasswordModal" style="position:fixed;left:0;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);z-index:9999;">
  <div style="background:white;padding:20px;border-radius:8px;min-width:280px;">
    <h3>Вход в UI</h3>
    <input id="uiPasswordInput" type="password" placeholder="Пароль" style="width:100%;padding:8px;margin-bottom:8px"/>
    <button id="uiPasswordSubmit">Войти</button>
    <div id="uiPwdError" style="color:red;margin-top:8px;display:none;">Неверный пароль</div>
  </div>
</div>
<script>
document.getElementById('uiPasswordSubmit').addEventListener('click', async ()=>{
  const pw = document.getElementById('uiPasswordInput').value;
  try{
    const r = await fetch('/ui-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
    if (r.ok){
      document.getElementById('uiPasswordModal').style.display='none';
      // optionally reload to get cookies applied
      location.reload();
    } else {
      document.getElementById('uiPwdError').style.display='block';
    }
  }catch(e){
    document.getElementById('uiPwdError').style.display='block';
  }
});
</script>
`;
    h = h.replace(/<\/body>/i, modal + '\n</body>');
  }

  // Add interactive radar toggle buttons placeholders (if not present)
  if (!/id=["']radarToggleBtn["']/.test(h)){
    const btns = `
<div style="margin:8px 0;">
  <button id="radarToggleBtn">RADAR — OFF</button>
  <button id="radarTestOnBtn">RadarTest ON</button>
  <button id="radarTestOffBtn">RadarTest OFF</button>
</div>
<script>
document.getElementById('radarToggleBtn').addEventListener('click', async ()=>{
  const enable = document.getElementById('radarToggleBtn').innerText.includes('OFF');
  const r = await fetch('/toggle-radar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enable,interactive:true})});
  if (r.ok){
    const j = await r.json();
    document.getElementById('radarToggleBtn').innerText = j.radarActive ? 'RADAR — ON' : 'RADAR — OFF';
  }
});
document.getElementById('radarTestOnBtn').addEventListener('click', async ()=>{
  await fetch('/toggle-radar-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enable:true,interactive:true})});
  alert('Test mode ON');
});
document.getElementById('radarTestOffBtn').addEventListener('click', async ()=>{
  await fetch('/toggle-radar-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enable:false,interactive:true})});
  alert('Test mode OFF');
});
</script>
`;
    h = h.replace(/<\/body>/i, btns + '\n</body>');
  }

  fs.writeFileSync(htmlFile, h, 'utf8');
  console.log('public/index.html patched.');
} else {
  console.warn('public/index.html not found; skipping webui html patch');
}

console.log('All patches attempted. Review .bak files if something unexpected happened.');
