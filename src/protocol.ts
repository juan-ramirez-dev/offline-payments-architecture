// Formatos de los QR y reglas del cupo. Todo se puede verificar sin internet con la
// llave pública raíz, que viene incluida en ambas apps.

import { decryptWith, encryptFor, fromB64url, fromUtf8, importEncryptionKey, importPublicKey, sign, toB64url, utf8, verify } from './crypto/primitives'

export const OFFLINE_LIMIT = 50_000 // pesos colombianos
export const MAX_PAYMENTS = 3
export const WINDOW_MS = 48 * 60 * 60 * 1000

/** Certificado del cupo sin internet. Lo firma la llave raíz al activar. */
export interface DeviceCert {
  u: string // userId
  nm: string // nombre visible
  d: string // deviceId
  w: string // windowId
  pk: string // llave pública del celular
  lim: number
  max: number
  exp: number
}

/** Certificado de la tienda. Lo firma la misma llave raíz al registrarla. */
export interface StoreCert {
  id: string
  name: string
  llave: string // llave Bre-B del comercio
  pk: string // llave pública de firma (comprobantes)
  ek: string // llave pública de cifrado (los pagos van cifrados para ella)
}

/** Lo firma el celular del cliente. */
export interface PaymentBody {
  st: string // storeId
  a: number // monto en pesos
  b0: number // saldo sin internet antes
  b1: number // saldo sin internet después
  s: number // número de pago dentro del cupo (1..max)
  ts: number
  n: string // nonce
}

/** Comprobante que firma la tienda: prueba de que aceptó el pago. */
export interface ReceiptBody {
  w: string
  s: number
  st: string
  a: number
  ts: number
}

export interface VerifiedPayment {
  cert: DeviceCert
  body: PaymentBody
}

export type RejectReason = 'formato' | 'alterado' | 'otra-tienda' | 'vencido' | 'limite-pagos' | 'saldo' | 'reusado'

export const rejectMessage: Record<RejectReason, string> = {
  formato: 'Este código no es un pago válido.',
  alterado: 'La firma no coincide: el código fue alterado o es falso.',
  'otra-tienda': 'Este pago fue generado para otra tienda.',
  vencido: 'El cupo sin internet de este cliente ya venció.',
  'limite-pagos': 'Se superó el límite de pagos sin internet.',
  saldo: 'El cliente no tiene saldo sin internet suficiente.',
  reusado: 'Este código ya fue cobrado.',
}

const STORE = 'TIENDA.'
const PAYMENT = 'PAGO.'
const RECEIPT = 'RECIBO.'

/** Serializa y firma: `base64url(json).base64url(firma)`. */
export async function seal<T>(data: T, key: CryptoKey): Promise<string> {
  const body = toB64url(utf8(JSON.stringify(data)))
  return `${body}.${toB64url(await sign(key, utf8(body)))}`
}

async function unseal<T>(body: string | undefined, sig: string | undefined, key: CryptoKey): Promise<T | null> {
  if (!body || !sig) return null
  try {
    if (!(await verify(key, fromB64url(sig), utf8(body)))) return null
    return JSON.parse(fromUtf8(fromB64url(body)))
  } catch {
    return null
  }
}

/** Lee el contenido sin verificar nada. Solo para mostrarlo. */
export function peek<T>(body: string | undefined): T | null {
  try {
    return body ? JSON.parse(fromUtf8(fromB64url(body))) : null
  } catch {
    return null
  }
}

async function keyFrom(pk: string): Promise<CryptoKey | null> {
  try {
    return await importPublicKey(fromB64url(pk))
  } catch {
    return null
  }
}

export const paymentId = (p: VerifiedPayment) => `${p.cert.w}:${p.body.s}`

// ---------- QR de la tienda (impreso) ----------

export const encodeStoreQr = (storeCert: string) => STORE + storeCert

export async function readStoreQr(text: string, root: CryptoKey): Promise<StoreCert | null> {
  if (!text.startsWith(STORE)) return null
  const [body, sig] = text.slice(STORE.length).split('.')
  return unseal<StoreCert>(body, sig, root)
}

// ---------- QR de pago (lo genera el cliente) ----------

/** Pago firmado: `cert.firmaRaíz.pago.firmaCelular`. Es lo que se sube al servidor. */
export async function signPayment(deviceCert: string, body: PaymentBody, deviceKey: CryptoKey): Promise<string> {
  return `${deviceCert}.${await seal(body, deviceKey)}`
}

export interface PaymentQrParts {
  epk: Uint8Array
  iv: Uint8Array
  ct: Uint8Array
}

/** QR de pago: `PAGO.` + llave efímera + iv + pago firmado cifrado con AES-256-GCM. */
export async function encryptPaymentQr(signed: string, store: StoreCert): Promise<string> {
  const { epk, iv, ct } = await encryptFor(await importEncryptionKey(fromB64url(store.ek)), utf8(signed))
  const blob = new Uint8Array(epk.length + iv.length + ct.length)
  blob.set(epk)
  blob.set(iv, epk.length)
  blob.set(ct, epk.length + iv.length)
  return PAYMENT + toB64url(blob)
}

export function paymentQrParts(text: string): PaymentQrParts | null {
  if (!text.startsWith(PAYMENT)) return null
  try {
    const blob = fromB64url(text.slice(PAYMENT.length))
    if (blob.length <= 65 + 12 + 16) return null
    return { epk: blob.slice(0, 65), iv: blob.slice(65, 77), ct: blob.slice(77) }
  } catch {
    return null
  }
}

/** Solo la tienda para la que se cifró puede abrirlo. */
export async function decryptPaymentQr(text: string, storeKey: CryptoKey): Promise<string | null> {
  const parts = paymentQrParts(text)
  const plain = parts && (await decryptWith(storeKey, parts))
  return plain ? fromUtf8(plain) : null
}

export interface PaymentInspection {
  cert: DeviceCert | null
  /** La raíz firmó el certificado del celular. */
  certOk: boolean
  body: PaymentBody | null
  /** El celular del certificado firmó este pago. */
  bodyOk: boolean
}

/** Revisa cada eslabón por separado para poder mostrar dónde se rompe la cadena. */
export async function inspectSignedPayment(signed: string, root: CryptoKey): Promise<PaymentInspection> {
  const parts = signed.split('.')
  const out: PaymentInspection = { cert: peek(parts[0]), certOk: false, body: peek(parts[2]), bodyOk: false }
  if (parts.length !== 4 || !out.cert || !out.body) return out
  out.certOk = !!(await unseal<DeviceCert>(parts[0], parts[1], root))
  const deviceKey = out.certOk ? await keyFrom(out.cert.pk) : null
  out.bodyOk = !!deviceKey && !!(await unseal<PaymentBody>(parts[2], parts[3], deviceKey))
  return out
}

/** Cadena de confianza: raíz → certificado del celular → firma del pago. */
export async function verifySignedPayment(
  signed: string,
  root: CryptoKey,
): Promise<{ ok: true; payment: VerifiedPayment } | { ok: false; reason: RejectReason }> {
  const { cert, certOk, body, bodyOk } = await inspectSignedPayment(signed, root)
  if (!cert || !body) return { ok: false, reason: 'formato' }
  if (!certOk || !bodyOk) return { ok: false, reason: 'alterado' }
  return { ok: true, payment: { cert, body } }
}

export type PaymentRule = 'otra-tienda' | 'vencido' | 'limite-pagos' | 'saldo'

/** Reglas del cupo. Las aplica la tienda (sin internet) y el servidor al liquidar. */
export function paymentRuleResults({ cert, body }: VerifiedPayment, storeId: string, at = Date.now()): { rule: PaymentRule; ok: boolean }[] {
  return [
    { rule: 'otra-tienda', ok: body.st === storeId },
    { rule: 'vencido', ok: body.ts <= cert.exp && at <= cert.exp },
    { rule: 'limite-pagos', ok: body.s >= 1 && body.s <= cert.max },
    { rule: 'saldo', ok: body.a > 0 && body.b0 <= cert.lim && body.b1 === body.b0 - body.a && body.b1 >= 0 },
  ]
}

export function checkPaymentRules(p: VerifiedPayment, storeId: string, at = Date.now()): RejectReason | null {
  return paymentRuleResults(p, storeId, at).find((r) => !r.ok)?.rule ?? null
}

// ---------- Comprobante (lo genera la tienda) ----------

export async function encodeReceiptQr(storeCert: string, body: ReceiptBody, storeKey: CryptoKey): Promise<string> {
  return `${RECEIPT}${storeCert}.${await seal(body, storeKey)}`
}

export async function verifyReceiptQr(text: string, root: CryptoKey): Promise<{ store: StoreCert; body: ReceiptBody } | null> {
  if (!text.startsWith(RECEIPT)) return null
  const parts = text.slice(RECEIPT.length).split('.')
  if (parts.length !== 4) return null
  const store = await unseal<StoreCert>(parts[0], parts[1], root)
  const storeKey = store && (await keyFrom(store.pk))
  const body = storeKey && (await unseal<ReceiptBody>(parts[2], parts[3], storeKey))
  return store && body ? { store, body } : null
}

export function receiptMatches(r: { store: StoreCert; body: ReceiptBody }, p: VerifiedPayment): boolean {
  return r.store.id === p.body.st && r.body.st === p.body.st && r.body.w === p.cert.w && r.body.s === p.body.s && r.body.a === p.body.a
}

/**
 * Simula a alguien que duplica el monto sin tener la llave del cliente. Puede volver a
 * cifrar para la tienda (su llave de cifrado es pública), pero no puede volver a firmar.
 */
export function tamperSignedPayment(signed: string): string {
  const parts = signed.split('.') // [cert, certSig, body, bodySig]
  const body = peek<PaymentBody>(parts[2])
  if (!body) return signed
  parts[2] = toB64url(utf8(JSON.stringify({ ...body, a: body.a * 2 })))
  return parts.join('.')
}

export const formatMoney = (pesos: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(pesos)
