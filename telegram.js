import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import { TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION, TELEGRAM_SOURCE } from './config.js'
import { infoLog, warnLog, errorLog } from './logger.js'
import { sendToWhatsApp } from './whatsapp.js'

export let tgClient = null

export async function startTelegram() {
  try {
    infoLog('🚀 Подключение к Telegram...')
    tgClient = new TelegramClient(
      new StringSession(TELEGRAM_STRING_SESSION || ''),
      Number(TELEGRAM_API_ID),
      TELEGRAM_API_HASH,
      { connectionRetries: 5 }
    )
    await tgClient.connect()
    infoLog('✅ Telegram подключён')
    tgClient.addEventHandler(onTelegramMessage, new NewMessage({}))
  } catch (e) {
    errorLog('❌ Ошибка Telegram: ' + (e?.message || e))
    tgClient = null
  }
}

async function onTelegramMessage(event) {
  try {
    const message = event.message
    if (!message) return
    const sender = await message.getSender().catch(()=>null)
    const senderIdStr = sender?.id ? String(sender.id) : ''
    const senderUsername = sender?.username ? ('' + sender.username).replace(/^@/,'').toLowerCase() : ''
    const source = (TELEGRAM_SOURCE || '').toString().replace(/^@/,'').toLowerCase()
    const isFromSource = source && (senderUsername === source || senderIdStr === source || ('-' + senderIdStr) === source)

    let text = null
    if (message.message && typeof message.message === 'string') text = message.message

    if (isFromSource && text && String(text).trim()) {
      infoLog('✉️ Получено из TG: ' + String(text).slice(0,200))
      await sendToWhatsApp(String(text))
    }
  } catch (e) {
    errorLog('⚠️ Ошибка обработки TG event: ' + (e?.message || e))
  }
}
