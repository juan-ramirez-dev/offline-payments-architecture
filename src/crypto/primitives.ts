// Primitivas criptográficas reales (WebCrypto): firmas ECDSA P-256 y cifrado ECDH P-256 + AES-256-GCM.

const enc = new TextEncoder()
const dec = new TextDecoder()

export const utf8 = (s: string) => enc.encode(s)
export const fromUtf8 = (b: Uint8Array) => dec.decode(b)

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function toB64url(bytes: Uint8Array): string {
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const ECDSA_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

/**
 * Par de llaves P-256. La privada no es exportable: en un celular real vive en el
 * Secure Enclave / StrongBox, y la raíz del servidor en AWS KMS.
 */
export function generateSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA_KEY, false, ['sign', 'verify'])
}

export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}

export function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ECDSA_KEY, true, ['verify'])
}

export async function sign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, key, data))
}

export function verify(key: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify(ECDSA_SIGN, key, signature, data)
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

// ---------- Cifrado de extremo a extremo (ECIES: ECDH + HKDF + AES-GCM) ----------

const ECDH_KEY = { name: 'ECDH', namedCurve: 'P-256' } as const
const HKDF_INFO = utf8('pagos-sin-internet/v1')

/** Par de llaves de cifrado de la tienda. La privada tampoco es exportable. */
export function generateEncryptionKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_KEY, false, ['deriveBits'])
}

export function importEncryptionKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ECDH_KEY, true, [])
}

async function sharedAesKey(privateKey: CryptoKey, publicKey: CryptoKey, salt: Uint8Array, usage: KeyUsage) {
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO }, hkdf, { name: 'AES-GCM', length: 256 }, false, [usage])
}

export interface Sealed {
  /** Llave pública efímera, nueva en cada pago. */
  epk: Uint8Array
  iv: Uint8Array
  /** Texto cifrado + etiqueta de autenticación de 16 bytes. */
  ct: Uint8Array
}

/** Cifra para quien tenga la privada de `recipient`. Solo hace falta su llave pública. */
export async function encryptFor(recipient: CryptoKey, plaintext: Uint8Array): Promise<Sealed> {
  const eph = await crypto.subtle.generateKey(ECDH_KEY, false, ['deriveBits'])
  const epk = await exportPublicKey(eph.publicKey)
  const iv = randomBytes(12)
  const key = await sharedAesKey(eph.privateKey, recipient, epk, 'encrypt')
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: epk }, key, plaintext))
  return { epk, iv, ct }
}

/** Devuelve null si no es para esta llave o si alguien tocó un solo byte. */
export async function decryptWith(privateKey: CryptoKey, { epk, iv, ct }: Sealed): Promise<Uint8Array | null> {
  try {
    const key = await sharedAesKey(privateKey, await importEncryptionKey(epk), epk, 'decrypt')
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: epk }, key, ct))
  } catch {
    return null
  }
}
