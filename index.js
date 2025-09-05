// index.js (TG → WA Bridge с полным UI и авто-пересылкой TG → WA)
import 'dotenv/config'
import express from 'express'
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import chalk from 'chalk'
import P from 'pino'
import { Boom } from '@hapi/boom'
import util from 'util'

// ----------------- NOISY LOGS FILTER -----------------
const SUPPRESS_PATTERNS = [
  'Closing stale open session',
  'Closing session: SessionEntry',
  'SessionEntry',
  'ephemeralKeyPair',
  'privKey: <Buffer',
  'pubKey: <Buffer',
  'currentRatchet',
  'lastRemoteEphemeralKey',
  'rootKey',
  'preKeyId:',
  'chainKey: [Object]',
  'messageKeys: {}'
]
function shouldSuppressLogLine(s) {
  if (!s) return false
  try { for (const p of SUPPRESS_PATTERNS) if (s.indexOf(p) !== -1) return true } catch(e){}
  return false
}
const _origLog = console.log.bind(console)
const _origInfo = console.info.bind(console)
const _origWarn = console.warn.bind(console)
const _origError = console.error.bind(console)
;['log','info','warn','error'].forEach(level => {
  const orig = { log:_origLog, info:_origInfo, warn:_origWarn, error:_origError }[level]
  console[level] = (...args)=>{
    try {
      const s = util.format(...args)
      if(shouldSuppressLogLine(s)) return
      orig(s)
    } catch(e){ orig(...args) }
  }
})
// ----------------- end filter -----------------

// ---- env/config ----
const {
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
  LOG_LEVEL
} = process.env

const CONFIG_GROUP_ID = (WA_GROUP_ID && WA_GROUP_ID.trim()) ? WA_GROUP_ID.trim()
  : (WHATSAPP_GROUP_ID && WHATSAPP_GROUP_ID.trim() ? WHATSAPP_GROUP_ID.trim() : null)
const CONFIG_GROUP_NAME = (WA_GROUP_NAME && WA_GROUP_NAME.trim()) ? WA_GROUP_NAME.trim()
  : (WHATSAPP_GROUP_NAME && WHATSAPP_GROUP_NAME.trim() ? WHATSAPP_GROUP_NAME.trim() : null)

// ---- ensure temp dirs ----
try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (e) {}
try { fs.mkdirSync('logs', { recursive: true }) } catch (e) {}
const LOG_FILE = path.join('logs', 'bridge.log')
const LOCK_FILE = path.join(AUTH_DIR, '.singleton.lock')

// ---- singleton lock ----
try {
  const fd = fs.openSync(LOCK_FILE, 'wx')
  fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
  fs.closeSync(fd)
  const cleanupLock = () => { try { fs.rmSync(LOCK_FILE) } catch(e){} }
  process.on('exit', cleanupLock)
  process.on('SIGINT', cleanupLock)
  process.on('SIGTERM', cleanupLock)
} catch(e){
  console.error(chalk.red('❌ Another instance appears to be running (lockfile exists). Exiting.'))
  process.exit(1)
}

// ---- logging helpers ----
function appendLogLine(s){ try{ fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`) }catch(e){} }
function infoLog(s){ console.log(chalk.cyan(s)); appendLogLine(s) }
function warnLog(s){ console.log(chalk.yellow(s)); appendLogLine(s) }
function errorLog(s){ console.error(chalk.red(s)); appendLogLine(s) }

// ---- globals ----
let tgClient=null
let sock=null
let lastQR=null
let waConnectionStatus='disconnected'
let isStartingWA=false
let saveAuthTimer=null
let restartTimer=null
let restartCount=0
let cachedGroupJid=null

const PLOGGER=P({level:LOG_LEVEL||'error'})
const UI_DOMAIN=process.env.RENDER_EXTERNAL_URL||`http://localhost:${PORT}`
const MAX_CACHE=200
const recentForwarded=[]
const recentWAMessages=[]

// ---- Gist helpers ----
async function loadAuthFromGistToDir(dir){
  if(!GITHUB_TOKEN || !GIST_ID){ warnLog('GITHUB_TOKEN/GIST_ID not set'); return false }
  try{
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, { headers:{Authorization:`token ${GITHUB_TOKEN}`}, timeout:15000 })
    const files=res.data.files
    if(!files || Object.keys(files).length===0){ warnLog('Gist empty'); return false }
    fs.mkdirSync(dir, {recursive:true})
    for(const [filename, fileObj] of Object.entries(files)){
      const fp=path.join(dir, filename)
      fs.writeFileSync(fp, fileObj.content||'','utf8')
    }
    infoLog('📥 Сессия загружена из Gist')
    return true
  }catch(err){ warnLog('⚠️ Ошибка загрузки auth из Gist: '+(err?.message||err)); return false }
}
function debounceSaveAuthToGist(dir){
  if(saveAuthTimer) clearTimeout(saveAuthTimer)
  saveAuthTimer=setTimeout(()=>{ saveAuthToGist(dir).catch(()=>{}) }, 2500)
}
async function saveAuthToGist(dir){
  if(!GITHUB_TOKEN || !GIST_ID){ warnLog('GITHUB_TOKEN/GIST_ID not set'); return }
  try{
    if(!fs.existsSync(dir)){ warnLog('AUTH dir missing'); return }
    const files={}
    for(const f of fs.readdirSync(dir)){
      const fp=path.join(dir,f)
      if(!fs.statSync(fp).isFile()) continue
      files[f]={ content: fs.readFileSync(fp,'utf8') }
    }
    if(Object.keys(files).length===0){ warnLog('No auth files to save'); return }
    await axios.patch(`https://api.github.com/gists/${GIST_ID}`, {files}, {headers:{Authorization:`token ${GITHUB_TOKEN}`}, timeout:15000})
    infoLog('✅ Auth сохранён в Gist')
  }catch(err){ warnLog('⚠️ Ошибка при сохранении auth: '+(err?.message||err)) }
}

// ---- Telegram ----
async function startTelegram(){
  try{
    infoLog('🚀 Подключение к Telegram...')
    tgClient = new TelegramClient(new StringSession(TELEGRAM_STRING_SESSION||''), Number(TELEGRAM_API_ID), TELEGRAM_API_HASH, { connectionRetries:5 })
    await tgClient.connect()
    infoLog('✅ Telegram подключён')
    tgClient.addEventHandler(onTelegramMessage, new NewMessage({}))
  }catch(e){ errorLog('❌ Ошибка Telegram: '+(e?.message||e)); tgClient=null }
}
async function sendTelegramNotification(text){
  if(!tgClient || !TELEGRAM_SOURCE) return
  try{ await tgClient.sendMessage(TELEGRAM_SOURCE,{message:String(text)}) }catch(e){ warnLog('⚠️ Не удалось отправить уведомление в Telegram: '+(e?.message||e)) }
}

// ** Главная функция: пересылка сообщений TG → WA **
async function onTelegramMessage(event){
  try{
    const message=event.message
    if(!message) return
    const sender=await message.getSender().catch(()=>null)
    const senderIdStr=sender?.id ? String(sender.id) : ''
    const senderUsername=sender?.username ? (''+sender.username).replace(/^@/,'').toLowerCase() : ''
    const source=(TELEGRAM_SOURCE||'').toString().replace(/^@/,'').toLowerCase()
    const isFromSource = source && (senderUsername===source || senderIdStr===source || ('-'+senderIdStr)===source)

    let text=null
    if(message.message && typeof message.message==='string') text=message.message
    else if(message.message?.message?.conversation) text=message.message.message.conversation
    else if(message.message?.message?.text) text=message.message.message.text

    if(isFromSource && text && String(text).trim()){
      infoLog('✉️ Получено из TG: '+String(text).slice(0,200))
      // пересылаем в WhatsApp
      await sendToWhatsApp(String(text))
    }else{
      if(text && String(text).trim()) infoLog(`ℹ️ TG ignored from='${senderUsername||senderIdStr}' preview='${String(text).slice(0,80)}'`)
    }
  }catch(e){ errorLog('⚠️ Ошибка обработки TG event: '+(e?.message||e)) }
}

// ---- WhatsApp ----
function scheduleRestart({reset=false}={}){ 
  if(restartTimer) return
  restartCount=Math.min(restartCount+1,8)
  const delay=Math.min(60000, Math.pow(2,restartCount)*1000)
  infoLog(`ℹ️ Планируем рестарт WA через ${Math.round(delay/1000)}s (reset=${reset})`)
  restartTimer=setTimeout(()=>{
    restartTimer=null
    startWhatsApp({reset}).catch(e=>warnLog('⚠️ Ошибка рестарта WA: '+(e?.message||e)))
  }, delay)
}

async function startWhatsApp({reset=false}={}){ 
  if(isStartingWA){ infoLog('ℹ️ startWhatsApp уже выполняется'); return }
  isStartingWA=true
  waConnectionStatus='connecting'
  infoLog(`🚀 Запуск WhatsApp... reset=${reset}`)

  try{ fs.mkdirSync(AUTH_DIR,{recursive:true}) }catch(e){}
  if(!reset) await loadAuthFromGistToDir(AUTH_DIR).catch(()=>{})
  else { try{ fs.rmSync(AUTH_DIR,{recursive:true,force:true}); fs.mkdirSync(AUTH_DIR,{recursive:true}) }catch(e){} lastQR=null; infoLog('ℹ️ Пустое AUTH_DIR для новой авторизации') }

  let state, saveCreds
  try{ ({state, saveCreds} = await useMultiFileAuthState(AUTH_DIR)) }catch(e){ errorLog('❌ useMultiFileAuthState failed: '+(e?.message||e)); isStartingWA=false; scheduleRestart({reset:false}); return }

  let version=undefined
  try{ version=(await fetchLatestBaileysVersion()).version }catch(e){}

  try{ sock=makeWASocket({version, auth:{creds:state.creds, keys:makeCacheableSignalKeyStore(state.keys,PLOGGER)}, logger:PLOGGER, browser:Browsers.appropriate('Render','Chrome'), printQRInTerminal:false}) }
  catch(e){ errorLog('❌ makeWASocket failed: '+(e?.message||e)); isStartingWA=false; scheduleRestart({reset:false}); return }

  sock.ev.on('creds.update', async ()=>{ try{await saveCreds()}catch(e){}; debounceSaveAuthToGist(AUTH_DIR) })

  sock.ev.on('connection.update', async update=>{
    try{
      const {connection, lastDisconnect, qr} = update
      if(qr){ lastQR=qr; waConnectionStatus='awaiting_qr'; infoLog('📱 QR сгенерирован'); qrcodeTerminal.generate(qr,{small:true}); await sendTelegramNotification('⚠️ Новый QR для WhatsApp') }
      if(connection==='open'){ waConnectionStatus='connected'; restartCount=0; cachedGroupJid && await cacheGroupId(true); lastQR=null; isStartingWA=false; infoLog('✅ WhatsApp подключён') }
      if(connection==='close'){ waConnectionStatus='disconnected'; isStartingWA=false; try{await sock?.end?.()}catch(e){}; scheduleRestart({reset:false}) }
    }catch(e){ errorLog('⚠️ Ошибка connection.update: '+(e?.message||e)); isStartingWA=false; scheduleRestart({reset:false}) }
  })

  sock.ev.on('messages.upsert', m=>{
    try{
      const raw=m?.messages?.[0]
      const text=raw?.message?.conversation || raw?.message?.extendedText?.text
      const from=raw?.key?.remoteJid
      if(text){ recentWAMessages.push({from:from||null,text:String(text),ts:Date.now()}); if(recentWAMessages.length>MAX_CACHE) recentWAMessages.shift() }
    }catch(e){}
  })
}

// ---- send ----
async function sendToWhatsApp(text){
  try{
    if(!sock || waConnectionStatus!=='connected'){ warnLog('⏳ WA не готов'); return false }
    const jid=cachedGroupJid || (CONFIG_GROUP_ID ? (CONFIG_GROUP_ID.endsWith('@g.us')?CONFIG_GROUP_ID:CONFIG_GROUP_ID+'@g.us') : null)
    if(!jid){ errorLog('❌ Нет JID группы'); return false }
    await sock.sendMessage(jid,{text:String(text)})
    infoLog('➡️ Отправлено в WA: '+String(text).slice(0,200))
    recentForwarded.push({text:String(text),ts:Date.now()}); if(recentForwarded.length>MAX_CACHE) recentForwarded.shift()
    return true
  }catch(e){ errorLog('❌ Ошибка отправки в WA: '+(e?.message||e)); return false }
}

// ---- cacheGroupId ----
async function cacheGroupId(sendWelcome=false){
  if(!sock || waConnectionStatus!=='connected'){ warnLog('WA not connected'); return }
  const groups=await sock.groupFetchAllParticipating()
  const list=Object.values(groups||{})
  cachedGroupJid=list[0]?.id || null
  if(sendWelcome && cachedGroupJid) await sendToWhatsApp('[🔧service🔧]\n[🌎подключено🌎]\n[🚨РАДАР АКТИВЕН🚨]')
}

// ---- HTTP + UI ----
const app=express()
app.use(express.json())
app.use(express.urlencoded({extended:true}))

app.get('/ping',(req,res)=>res.send('pong'))
app.get('/healthz',(req,res)=>res.status(200).send('ok'))

app.get('/wa/status',(req,res)=>res.send({ whatsapp:waConnectionStatus, qrPending:!!lastQR, waGroup: cachedGroupJid?{id:cachedGroupJid}:null }))
app.get('/wa/send',async(req,res)=>{ const text=req.query.text; if(!text) return res.status(400).send({error:'text required'}); const ok=await sendToWhatsApp(text); res.send({status:ok}) })

app.listen(PORT, ()=>infoLog(`🌐 Server listening on port ${PORT}`))

// ---- старт ----
startTelegram().catch(()=>{})
startWhatsApp({reset:false}).catch(()=>{})
