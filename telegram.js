import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import { TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION, TELEGRAM_SOURCE } from './config.js'
import { infoLog, warnLog, errorLog } from './logger.js'
import bus from './eventBus.js'

export let tgClient = null

export async function startTelegram() {
  try {
    infoLog('🚀 Подключение к Telegram...')
    tgClient = new TelegramClient(new StringSession(TELEGRAM_STRING_SESSION || ''), Number(TELEGRAM_API_ID), TELEGRAM_API_HASH, { connectionRetries: 5 })
    await tgClient.connect()
    infoLog('✅ Telegram подключён')
    tgClient.addEventHandler(onTelegramMessage, new NewMessage({}))
    // listen for WA notifications to forward into Telegram (QR, conflicts)
    bus.on('wa.notification', async (text) => {
      await sendTelegramNotification(text).catch(()=>{})
    })
  } catch (e) {
    errorLog('❌ Ошибка Telegram: ' + (e?.message || e))
    tgClient = null
  }
}

export async function sendTelegramNotification(text) {
  try {
    if (!tgClient || !TELEGRAM_SOURCE) return
    await tgClient.sendMessage(TELEGRAM_SOURCE, { message: String(text) })
    infoLog('➡️ Уведомление отправлено в TG')
  } catch (e) {
    warnLog('⚠️ Не удалось отправить уведомление в Telegram: ' + (e?.message || e))
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
    else if (message.message?.message?.conversation) text = message.message.message.conversation
    else if (message.message?.message?.text) text = message.message.message.text

    if (isFromSource && text && String(text).trim()) {
      infoLog('✉️ Получено из TG: ' + String(text).slice(0,200))
      // emit event for WA to pick up and forward
      bus.emit('tg.message', String(text))
    } else {
      if (text && String(text).trim()) {
        infoLog(`ℹ️ TG message ignored (not from source). from='${senderUsername||senderIdStr}' srcExpected='${source}' preview='${String(text).slice(0,80)}'`)
      }
    }
  } catch (e) {
    errorLog('⚠️ Ошибка обработки TG event: ' + (e?.message || e))
  }
}
