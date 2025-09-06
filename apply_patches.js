// fix_index.js
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.js');
let code = fs.readFileSync(file, 'utf8');

// 1. Убираем импорт из whatsapp.js
code = code.replace(/import\s*\{?\s*startWhatsApp[^\n]*from\s*['"][^'"]+['"]\s*;?\n?/g, '');

// 2. Проверяем, что функция определена
if (!/function\s+startWhatsApp\s*\(/.test(code)) {
  code = `async function startWhatsApp(reset = false) {\n  console.log("✅ startWhatsApp заглушка вызвана, добавь сюда код WhatsApp");\n}\n\n` + code;
  console.log('⚠️ Вставлена заглушка функции startWhatsApp — допиши логику инициализации WhatsApp!');
}

// 3. Сохраняем
const backup = file + '.bak.' + Date.now();
fs.copyFileSync(file, backup);
fs.writeFileSync(file, code, 'utf8');
console.log('✔ index.js исправлен. Бэкап:', backup);
