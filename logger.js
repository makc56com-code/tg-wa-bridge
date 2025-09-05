import fs from 'fs'
import path from 'path'
import chalk from 'chalk'
import util from 'util'

const LOG_DIR = path.join(process.cwd(), 'logs')
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch (e) {}
export const LOG_FILE = path.join(LOG_DIR, 'bridge.log')

function appendLogLine(s) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`) } catch (e) {}
}

export function infoLog(s) { console.log(chalk.cyan(s)); appendLogLine(util.format(s)) }
export function warnLog(s) { console.log(chalk.yellow(s)); appendLogLine(util.format(s)) }
export function errorLog(s) { console.error(chalk.red(s)); appendLogLine(util.format(s)) }

// optional small noisy-filter similar to старого варианта — можно включать при отладке
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
export function shouldSuppressLogLine(s) {
  if (!s) return false
  try {
    for (const p of SUPPRESS_PATTERNS) if (s.indexOf(p) !== -1) return true
  } catch (e) {}
  return false
}
