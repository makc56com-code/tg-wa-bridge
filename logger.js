import fs from 'fs'
import chalk from 'chalk'
import util from 'util'
import { LOG_FILE } from './config.js'

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
  try {
    for (const p of SUPPRESS_PATTERNS) {
      if (s.indexOf(p) !== -1) return true
    }
  } catch (e) {}
  return false
}

const _orig = { log: console.log, info: console.info, warn: console.warn, error: console.error }
;['log','info','warn','error'].forEach(level => {
  const orig = _orig[level].bind(console)
  console[level] = (...args) => {
    try {
      const s = util.format(...args)
      if (shouldSuppressLogLine(s)) return
      orig(s)
    } catch (e) {
      orig(...args)
    }
  }
})

export function appendLogLine(s) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`) } catch (e) {}
}

export function infoLog(s) { console.log(chalk.cyan(s)); appendLogLine(s) }
export function warnLog(s) { console.log(chalk.yellow(s)); appendLogLine(s) }
export function errorLog(s) { console.error(chalk.red(s)); appendLogLine(s) }
