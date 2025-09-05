import 'dotenv/config'

export const TELEGRAM_API_ID = process.env.TELEGRAM_API_ID
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH
export const TELEGRAM_STRING_SESSION = process.env.TELEGRAM_STRING_SESSION
export const TELEGRAM_SOURCE = process.env.TELEGRAM_SOURCE

export const WA_GROUP_ID = process.env.WA_GROUP_ID
export const WA_GROUP_NAME = process.env.WA_GROUP_NAME || process.env.WHATSAPP_GROUP_NAME

export const PORT = process.env.PORT || 3000
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-token'
export const AUTH_DIR = process.env.AUTH_DIR || '/tmp/auth_info_baileys'

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN
export const GIST_ID = process.env.GIST_ID

// UI domain (render sets RENDER_EXTERNAL_URL)
export const UI_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`

// logging level default
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
