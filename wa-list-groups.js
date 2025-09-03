import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const { Client: WAClient, LocalAuth } = pkg;

async function startWAClient() {
  const waClient = new WAClient({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: { headless: false, args: ['--no-sandbox'], defaultViewport: null }
  });

  waClient.on('qr', qr => {
    console.log('📱 QR-код для WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  waClient.on('authenticated', () => {
    console.log('✅ WhatsApp авторизация успешна');
  });

  waClient.on('ready', async () => {
    console.log('✅ WhatsApp готов');

    // Ждем загрузки window.Store и чатов
    await waClient.pupPage.waitForFunction(
      'window.Store && window.Store.Chat && window.Store.Chat.models.length > 0',
      { timeout: 120000 }
    );

    console.log('⌛ Начинаю поиск групп...');

    const chats = await waClient.getChats();
    const groups = [];

    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      process.stdout.write(`🔍 Проверка чата ${i + 1}/${chats.length}: ${chat.name}\r`);

      if (chat.isGroup) {
        console.log(`✅ Найдена группа: ${chat.name} | ID: ${chat.id._serialized}`);
        groups.push(chat);
      }

      // Небольшая задержка, чтобы маркеры успевали выводиться
      await new Promise(res => setTimeout(res, 100));
    }

    console.log(`\n🔵 Всего найдено групп: ${groups.length}`);
  });

  await waClient.initialize();
}

startWAClient();
