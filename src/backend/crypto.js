const enc = new TextEncoder()
const dec = new TextDecoder()
const AAD = enc.encode('mamina-telegram-secret:v1')

function toB64Url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}
function fromB64Url(s) {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)
  const bin = atob(b64)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}
async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
export async function encryptCredentials({ apiId, apiHash }, password, iterations = 600000) {
  if (!Number.isInteger(Number(apiId)) || !apiHash || !password) throw new Error('apiId, apiHash et mot de passe requis.')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, iterations)
  const plaintext = enc.encode(JSON.stringify({ apiId: Number(apiId), apiHash: String(apiHash) }))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plaintext))
  return {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: toB64Url(salt),
    cipher: 'AES-256-GCM',
    iv: toB64Url(iv),
    ciphertext: toB64Url(ciphertext),
  }
}
export async function decryptCredentials(blob, password) {
  if (blob?.version !== 1 || blob?.kdf !== 'PBKDF2-SHA256' || blob?.cipher !== 'AES-256-GCM') throw new Error('Format de secret non supporté.')
  const key = await deriveKey(password, fromB64Url(blob.salt), Number(blob.iterations))
  let plain
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64Url(blob.iv), additionalData: AAD }, key, fromB64Url(blob.ciphertext))
  } catch {
    throw new Error('Mot de passe incorrect ou secret altéré.')
  }
  const value = JSON.parse(dec.decode(plain))
  if (!Number.isInteger(value.apiId) || typeof value.apiHash !== 'string' || value.apiHash.length < 8) throw new Error('Secret déchiffré invalide.')
  return value
}
export async function loadEncryptedSecret(url = './telegram-secret.json') {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`Secret chiffré introuvable (${r.status}). Crée public/telegram-secret.json.`)
  return r.json()
}
