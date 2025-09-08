import fs from 'fs'
import path from 'path'

// --- ENV переменные ---
export const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION,
  TELEGRAM_SOURCE,
  WA_GROUP_ID,
  WA_GROUP_NAME,
  WHATSAPP_GROUP_ID,
  WHATSAPP_GROUP_NAME,
  PORT = 3000,
  GITHUB_TOKEN,
  GIST_ID,
  AUTH_DIR = '/tmp/auth_info_baileys',
  ADMIN_TOKEN = 'admin-token',
  LOG_LEVEL,
  UI_DOMAIN = 'http://localhost:3000' // <-- новый экспорт
} = process.env

// --- WhatsApp конфигурация ---
export const CONFIG_GROUP_ID = (WA_GROUP_ID && WA_GROUP_ID.trim()) ? WA_GROUP_ID.trim()
  : (WHATSAPP_GROUP_ID && WHATSAPP_GROUP_ID.trim() ? WHATSAPP_GROUP_ID.trim() : null)

export const CONFIG_GROUP_NAME = (WA_GROUP_NAME && WA_GROUP_NAME.trim()) ? WA_GROUP_NAME.trim()
  : (WHATSAPP_GROUP_NAME && WHATSAPP_GROUP_NAME.trim() ? WHATSAPP_GROUP_NAME.trim() : null)

// --- директории ---
try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
try { fs.mkdirSync('logs', { recursive: true }) } catch (e) {}

// --- лог-файлы и lock ---
export const LOG_FILE = path.join('logs', 'bridge.log')
export const LOCK_FILE = path.join(AUTH_DIR, '.singleton.lock')
