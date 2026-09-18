const PREFIX = 'MAMINA::'
const enc = new TextEncoder()
const dec = new TextDecoder()
function b64u(bytes) {
  let s=''; for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/g,'')
}
function unb64u(s) {
  const b64=s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4)
  return Uint8Array.from(atob(b64), c=>c.charCodeAt(0))
}
export const Slots = Object.freeze({ TOP:'h', BOTTOM:'b', PAGE:'p' })
export function articleKey(magazineId, page, slot) {
  if (!['h','b','p'].includes(slot)) throw new Error('Slot invalide.')
  return `${magazineId}:p${String(page).padStart(2,'0')}:${slot}`
}
export function packMeta(meta) {
  const payload = { v:1, ...meta }
  return PREFIX + b64u(enc.encode(JSON.stringify(payload)))
}
export function withMeta(humanText, meta) {
  const t = (humanText || '').trim()
  return `${t}${t?'\n\n':''}${packMeta(meta)}`
}
export function parseMeta(text='') {
  const line = String(text).split(/\r?\n/).reverse().find(x=>x.startsWith(PREFIX))
  if (!line) return null
  try {
    const obj = JSON.parse(dec.decode(unb64u(line.slice(PREFIX.length))))
    return obj?.v === 1 ? obj : null
  } catch { return null }
}
export function stripMeta(text='') {
  return String(text).split(/\r?\n/).filter(x=>!x.startsWith(PREFIX)).join('\n').trim()
}
export function canonicalRoots(messages) {
  const groups = new Map()
  for (const m of messages) {
    const meta = parseMeta(m.text || m.caption || '')
    if (meta?.kind !== 'root' || !meta.articleKey) continue
    if (!groups.has(meta.articleKey)) groups.set(meta.articleKey, [])
    groups.get(meta.articleKey).push({ message:m, meta })
  }
  const out = new Map()
  for (const [key, list] of groups) {
    list.sort((a,b)=>Number(a.message.id)-Number(b.message.id))
    out.set(key, { canonical:list[0], duplicates:list.slice(1) })
  }
  return out
}
