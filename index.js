// index.js
import 'dotenv/config';
import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import qrcodeTerminal from 'qrcode-terminal';

// ---------------- Конфиг ----------------
const TELEGRAM_API_ID = process.env.TELEGRAM_API_ID;
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_STRING_SESSION = process.env.TELEGRAM_STRING_SESSION;
const TELEGRAM_SOURCE_CHAT = process.env.TELEGRAM_SOURCE_CHAT; // id чата или username
const WHATSAPP_TARGET_GROUP = process.env.WHATSAPP_TARGET_GROUP; // id группы в формате '123456789-123456@g.us'

// Состояние сервиса
let serviceEnabled = true;

// ---------------- Express ----------------
const app = express();
app.use(express.json());

// ---------------- WhatsApp ----------------
let waSocket;
async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  waSocket = makeWASocket.default({
    auth: state,
    browser: Browsers.macOS('WhatsApp'),
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('connection.update', (update) => {
    if (update.qr) qrcodeTerminal.generate(update.qr, { small: true });
    if (update.connection === 'open') {
      console.log('✅ WhatsApp подключён');
    }
  });
}

// ---------------- Telegram ----------------
const stringSession = new StringSession(TELEGRAM_STRING_SESSION);
const tgClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
  connectionRetries: 5,
});

async function initTelegram() {
  await tgClient.start({
    phoneNumber: async () => process.env.TELEGRAM_PHONE,
    password: async () => process.env.TELEGRAM_PASSWORD,
    phoneCode: async () => {
      console.log('Введите код из Telegram:');
      return new Promise((resolve) => {
        process.stdin.once('data', (input) => resolve(input.toString().trim()));
      });
    },
    onError: console.error,
  });
  console.log('✅ Telegram подключён');

  tgClient.addEventHandler(async (event) => {
    if (!serviceEnabled) return; // Если сервис выключен — ничего не пересылаем

    const message = event.message;
    if (!message || !message.text) return;

    try {
      await waSocket.sendMessage(WHATSAPP_TARGET_GROUP, {
        text: message.text,
      });
      console.log('📤 Сообщение переслано в WhatsApp:', message.text);
    } catch (e) {
      console.error('❌ Ошибка пересылки в WhatsApp:', e);
    }
  }, new NewMessage({ chats: [TELEGRAM_SOURCE_CHAT] }));
}

// ---------------- UI кнопки (HTTP API) ----------------
app.post('/service/:action', (req, res) => {
  const { action } = req.params;
  if (action === 'on') {
    serviceEnabled = true;
    console.log('🔔 Сервис включён');
    res.send('Сервис включён');
  } else if (action === 'off') {
    serviceEnabled = false;
    console.log('🔕 Сервис выключен');
    res.send('Сервис выключен');
  } else {
    res.status(400).send('Неверная команда');
  }
});

// ---------------- Запуск ----------------
(async () => {
  try {
    await initWhatsApp();
    await initTelegram();

    // Сообщение о состоянии сразу после деплоя
    console.log(serviceEnabled ? '🔔 Сервис включён (при старте)' : '🔕 Сервис выключен (при старте)');

    app.listen(process.env.PORT || 3000, () => {
      console.log('🌐 Сервер запущен на порту', process.env.PORT || 3000);
    });
  } catch (e) {
    console.error('❌ Ошибка инициализации:', e);
  }
})();
