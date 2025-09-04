// ---------------- GitHub Gist ----------------
async function loadSessionFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return { loaded: false, valid: false }

  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    })
    const data = await res.json()

    if (!data.files || Object.keys(data.files).length === 0) {
      console.log('⚠️ Gist пустой — сессия отсутствует')
      return { loaded: false, valid: false }
    }

    ensureDir(AUTH_DIR)
    for (const name in data.files) {
      const content = data.files[name].content
      fs.writeFileSync(path.join(AUTH_DIR, name), content, 'utf-8')
    }

    console.log('📥 Сессия из Gist загружена')

    // Простая проверка валидности — проверяем наличие ключевых файлов
    const requiredFiles = ['creds.json', 'keys.json']
    const valid = requiredFiles.every(f => fs.existsSync(path.join(AUTH_DIR, f)))

    if (!valid) console.log('⚠️ Сессия из Gist невалидна — будут проблемы при подключении')

    return { loaded: true, valid }
  } catch (e) {
    console.error('❌ Ошибка загрузки сессии из Gist:', e)
    return { loaded: false, valid: false }
  }
}

// ---------------- WhatsApp ----------------
async function startWhatsApp({ reset = false } = {}) {
  console.log('🚀 Старт WhatsApp...')

  let sessionStatus = {
    gistLoaded: false,
    gistValid: false,
    localDeleted: false,
    gistSavedAfterQR: false
  }

  if (reset) {
    rmDirSafe(AUTH_DIR)
    sessionStatus.localDeleted = true
  }

  const gistResult = await loadSessionFromGist()
  sessionStatus.gistLoaded = gistResult.loaded
  sessionStatus.gistValid = gistResult.valid

  if (!gistResult.loaded || !gistResult.valid) {
    console.log('⚠️ Сессия из Gist отсутствует или невалидна — потребуется авторизация QR')
  }

  ensureDir(AUTH_DIR)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate('Render', 'Chrome')
  })

  const DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`
  let triedReset = false

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    await saveSessionToGist()
  })

  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      qrcodeTerminal.generate(qr, { small: true })
      console.log('📱 Новый QR получен!')
      console.log(`🌍 Откройте QR в браузере: ${DOMAIN}/wa/qr`)
    } else if (lastQR) {
      console.log('✅ WhatsApp подключён, QR больше не нужен')
      lastQR = null
      sessionStatus.gistSavedAfterQR = true
      await saveSessionToGist()
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp подключён')
      await cacheGroupJid()
      if (waGroupJid) {
        const startupMsg = '🔧сервисное сообщение🔧\n[Подключение установлено, РАДАР АКТИВЕН 🌎]'
        await sendToWhatsApp(startupMsg)
      }

      // 🔹 Чек-лист статусов сессии
      console.log('📋 Состояние сессии WhatsApp:')
      console.log('   - Сессия из Gist загружена:', sessionStatus.gistLoaded)
      console.log('   - Сессия из Gist валидна:', sessionStatus.gistValid)
      console.log('   - Локальная сессия удалена:', sessionStatus.localDeleted)
      console.log('   - Сессия из Gist перезаписана после QR:', sessionStatus.gistSavedAfterQR)
    } else if (connection === 'close') {
      const err = lastDisconnect?.error
      console.log('❌ WhatsApp отключён', err ? `(${err?.message || err})` : '')

      if (!triedReset && err && /auth/i.test(err.message || '')) {
        console.log('⚠️ Сессия из Gist невалидна, пробуем сбросить и авторизоваться заново')
        triedReset = true
        await startWhatsApp({ reset: true })
        return
      }

      console.log('⏳ Переподключение через 5 секунд...')
      setTimeout(() => startWhatsApp({ reset: false }), 5000)
    }
  })
}
