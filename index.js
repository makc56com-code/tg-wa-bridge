// ---------------- WhatsApp (Baileys) ----------------
async function startWhatsApp({ reset = false } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate('Render', 'Chrome'),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update

    if (qr && !currentQR) { // Показываем QR только если его ещё нет
      console.log('📱 Новый QR получен')
      currentQR = qr
      qrcode.generate(qr, { small: true }) // локальный ASCII
      console.log(`🔗 Ссылка на веб-QR: https://tg-wa-bridge.onrender.com/wa/qr`)
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp подключён')
      currentQR = null // QR больше не нужен
      cacheGroupJid()
    }

    if (connection === 'close') {
      console.log('❌ WhatsApp отключён, переподключение через 5 секунд...')
      setTimeout(startWhatsApp, 5000)
    }
  })

  if (reset) {
    console.log('♻️ Сброс авторизации WhatsApp — ждите новый QR...')
    currentQR = null
  }
}
