// fix_startWhatsApp_import.js
// Запуск: node fix_startWhatsApp_import.js
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const indexPath = path.join(root, 'index.js');
const waPathCandidates = [
  path.join(root, 'whatsapp.js'),
  path.join(root, 'wa.js'),
  path.join(root, 'lib','whatsapp.js'),
  path.join(root, 'src','whatsapp.js')
];

function findWa(){
  for(const p of waPathCandidates){
    if (fs.existsSync(p)) return p;
  }
  // fallback: find any file with "startWhatsApp" mention
  const files = findFiles(root, /\.js$/);
  for(const f of files){
    const txt = fs.readFileSync(f,'utf8');
    if (txt.includes('startWhatsApp')) return f;
  }
  return null;
}

function findFiles(dir, re){
  const res = [];
  (function walk(d){
    for(const n of fs.readdirSync(d)){
      const fp = path.join(d,n);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (re.test(fp)) res.push(fp);
    }
  })(dir);
  return res;
}

const waPath = findWa();
if (!waPath){
  console.error('Не найден файл с определением startWhatsApp. Проверь whatsapp.js в корне или src.');
  process.exit(1);
}
console.log('Found WA module:', waPath);

const waCode = fs.readFileSync(waPath,'utf8');
let waExportType = null;
// heuristics
if (/module\.exports\s*=/.test(waCode)) waExportType = 'commonjs';
if (/exports\./.test(waCode)) waExportType = 'commonjs-exports';
if (/export\s+default\s+function|export\s+default/.test(waCode)) waExportType = 'esm-default';
if (/export\s+function|export\s+\{/.test(waCode)) waExportType = 'esm-named';

console.log('Detected WA module export type:', waExportType);

if (!fs.existsSync(indexPath)){
  console.error('index.js not found in repo root.');
  process.exit(1);
}

let indexCode = fs.readFileSync(indexPath,'utf8');
const backup = indexPath + '.bak.' + Date.now();
fs.copyFileSync(indexPath, backup);
console.log('Backup created:', backup);

// try to replace imports
if (waExportType === 'commonjs' || waExportType === 'commonjs-exports'){
  // replace "import { startWhatsApp" with require or import default + destructure
  if (/import\s+\{\s*startWhatsApp/.test(indexCode)){
    indexCode = indexCode.replace(/import\s+\{\s*startWhatsApp([^}]*)\}\s*from\s*['"][^'"]+['"]\s*;?/,
      "const { startWhatsApp$1 } = require('./" + path.basename(waPath) + "');");
    console.log('Replaced named ESM import to CommonJS require.');
  }
  // if used default import
  if (/import\s+startWhatsApp\s+from/.test(indexCode)){
    // convert to require default
    indexCode = indexCode.replace(/import\s+startWhatsApp\s+from\s*['"][^'"]+['"]\s*;?/,
      "const startWhatsApp = require('./" + path.basename(waPath) + "');");
    console.log('Replaced default ESM import to CommonJS require.');
  }
} else if (waExportType === 'esm-default'){
  // ensure default import exists
  if (/import\s+\{\s*startWhatsApp/.test(indexCode)){
    indexCode = indexCode.replace(/import\s+\{\s*startWhatsApp([^}]*)\}\s*from\s*['"][^'"]+['"]\s*;?/,
      "import startWhatsApp$1 from './" + path.basename(waPath) + "';");
    console.log('Replaced named import to default import for ESM default export.');
  } else {
    // nothing
  }
} else if (waExportType === 'esm-named'){
  // ensure named import exists
  if (!/import\s+\{\s*startWhatsApp/.test(indexCode)){
    // insert named import near top - add after other imports
    indexCode = indexCode.replace(/(import\s+[^\n]+\n)(?!import)/, `$1import { startWhatsApp } from './${path.basename(waPath)}';\n`);
    console.log('Inserted named import for startWhatsApp.');
  }
}

// Add debug logs before call if not present
if (!/DEBUG: startWhatsApp typeof/.test(indexCode)){
  indexCode = indexCode.replace(/(startWhatsApp\([^\)]*\))/,
    `console.log('DEBUG: startWhatsApp typeof =', typeof startWhatsApp);\nconsole.log('DEBUG: startWhatsApp =', startWhatsApp);\n$1`);
  console.log('Inserted DEBUG logs before startWhatsApp call.');
}

fs.writeFileSync(indexPath, indexCode, 'utf8');
console.log('Patched index.js. Please redeploy and check logs.');
