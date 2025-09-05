export function normalizeName(s) {
  if (!s) return ''
  return String(s).replace(/^[\s"'`]+|[\s"'`]+$/g, '').trim().toLowerCase()
}

export function stripNonAlnum(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi,'').trim()
}
