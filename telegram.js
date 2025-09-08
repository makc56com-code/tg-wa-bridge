import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TELEGRAM_SOURCE
} from './config.js'
import { infoLog, warnLog, errorLog } from './logger.js'
import { sendToWhatsApp } from './whatsapp.js'

export let tgClient = null

// === Функция для отправки уведомлений в TG ===
export async function sendTelegramNotification(text) {
  try {
    if (!tgClient) {
      warnLog('⚠️ TG client не подключён — уведомление не отправлено')
      return
    }
    if (!TELEGRAM_SOURCE) {
      warnLog('⚠️ TELEGRAM_SOURCE не указан — уведомление не отправлено')
      return
    }
    const chatId = TELEGRAM_SOURCE.startsWith('-') ? TELEGRAM_SOURCE : '@' + TELEGRAM_SOURCE
    await tgClient.sendMessage(chatId, { message: String(text) })
    infoLog('➡️ Отправлено уведомление в TG: ' + String(text).slice(0, 200))
  } catch (e) {
    errorLog('❌ Ошибка отправки уведомления в TG: ' + (e?.message || e))
  }
}

// === Старт TG ===
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

    // Вешаем обработчик на новые сообщения
    tgClient.addEventHandler(onTelegramMessage, new NewMessage({}))
  } catch (e) {
    errorLog('❌ Ошибка Telegram: ' + (e?.message || e))
    tgClient = null
  }
}

// === Обработка входящих сообщений ===
async function onTelegramMessage(event) {
  try {
    const message = event.message
    if (!message) return

    const sender = await message.getSender().catch(() => null)
    const senderIdStr = sender?.id ? String(sender.id) : ''
    const senderUsername = sender?.username ? ('' + sender.username).replace(/^@/, '').toLowerCase() : ''

    const source = (TELEGRAM_SOURCE || '').toString().replace(/^@/, '').toLowerCase()
    const isFromSource =
      source &&
      (senderUsername === source || senderIdStr === source || ('-' + senderIdStr) === source)

    let text = null
    if (message.message && typeof message.message === 'string') text = message.message

    if (isFromSource && text && String(text).trim()) {
      infoLog('✉️ Получено из TG: ' + String(text).slice(0, 200))
      await sendToWhatsApp(String(text))
    }
  } catch (e) {
    errorLog('⚠️ Ошибка обработки TG event: ' + (e?.message || e))
  }
}
