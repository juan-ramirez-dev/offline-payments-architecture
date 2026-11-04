// Lógica que corre en el celular del cliente, sin internet.

import { randomBytes, toB64url } from '../crypto/primitives'
import type { Activation, SettleResult } from '../server/mockServer'
import { encryptPaymentQr, signPayment, type PaymentBody, type StoreCert } from '../protocol'

export type PaymentStatus = 'pendiente' | 'aceptado' | 'confirmado' | 'esperando' | 'rechazado'

export interface LocalPayment {
  windowId: string
  seq: number
  storeId: string
  storeName: string
  storeLlave: string
  amount: number
  createdAt: number
  status: PaymentStatus
  /** Pago firmado. Es lo que se sube al servidor al sincronizar. */
  signed: string
  /** El mismo pago cifrado para la tienda: lo que va en el QR. */
  qr: string
  /** Comprobante firmado por la tienda, si el cliente lo escaneó. */
  receipt?: string
}

export interface OfflineState {
  windowId: string
  certEnv: string
  /** Llave privada del celular. En un celular real vive en el Secure Enclave / StrongBox. */
  signingKey: CryptoKey
  seq: number
  balance: number
  limit: number
  maxPayments: number
  expiresAt: number
  payments: LocalPayment[]
}

export interface Wallet {
  userId: string
  deviceId: string
  name: string
  llave: string // llave Bre-B del cliente
  mainBalance: number
  offline: OfflineState | null
  history: LocalPayment[]
}

export function applyActivation(wallet: Wallet, a: Activation, signingKey: CryptoKey): Wallet {
  return {
    ...wallet,
    mainBalance: a.balance,
    offline: {
      windowId: a.cert.w,
      certEnv: a.certEnv,
      signingKey,
      seq: 0,
      balance: a.cert.lim,
      limit: a.cert.lim,
      maxPayments: a.cert.max,
      expiresAt: a.cert.exp,
      payments: [],
    },
  }
}

export type PayBlock = 'sin-cupo' | 'limite-pagos' | 'vencido' | 'sin-saldo'

export function payBlockReason(off: OfflineState | null): PayBlock | null {
  if (!off) return 'sin-cupo'
  if (off.seq >= off.maxPayments) return 'limite-pagos'
  if (Date.now() > off.expiresAt) return 'vencido'
  if (off.balance <= 0) return 'sin-saldo'
  return null
}

export async function createOfflinePayment(wallet: Wallet, store: StoreCert, amount: number) {
  const off = wallet.offline
  const block = payBlockReason(off)
  if (!off || block) throw new Error(block ?? 'sin-cupo')
  if (amount <= 0 || amount > off.balance) throw new Error('saldo')

  const seq = off.seq + 1
  const balanceAfter = off.balance - amount
  const body: PaymentBody = { st: store.id, a: amount, b0: off.balance, b1: balanceAfter, s: seq, ts: Date.now(), n: toB64url(randomBytes(8)) }
  const signed = await signPayment(off.certEnv, body, off.signingKey)
  const qr = await encryptPaymentQr(signed, store)

  const payment: LocalPayment = {
    windowId: off.windowId,
    seq,
    storeId: store.id,
    storeName: store.name,
    storeLlave: store.llave,
    amount,
    createdAt: Date.now(),
    status: 'pendiente',
    signed,
    qr,
  }
  const next: Wallet = { ...wallet, offline: { ...off, seq, balance: balanceAfter, payments: [...off.payments, payment] } }
  return { wallet: next, payment, body }
}

export function attachReceipt(wallet: Wallet, seq: number, receipt: string): Wallet {
  const off = wallet.offline
  if (!off) return wallet
  const payments = off.payments.map((p) => (p.seq === seq ? { ...p, receipt, status: 'aceptado' as const } : p))
  return { ...wallet, offline: { ...off, payments } }
}

/** Marca cada pago local según lo que respondió el servidor y lo pasa al historial. */
export function settleWindow(wallet: Wallet, statuses: Record<number, SettleResult>, balance: number): Wallet {
  const settled = (wallet.offline?.payments ?? []).map((p) => ({ ...p, status: statuses[p.seq]?.status ?? p.status }))
  return { ...wallet, mainBalance: balance, offline: null, history: [...settled.reverse(), ...wallet.history] }
}

/** Actualiza los pagos en espera cuando la tienda los liquida después. */
export function applyStatuses(wallet: Wallet, statuses: Record<string, 'confirmado' | 'esperando'>, balance: number): Wallet {
  const history = wallet.history.map((p) => {
    const s = statuses[`${p.windowId}:${p.seq}`]
    return p.status === 'esperando' && s ? { ...p, status: s } : p
  })
  return { ...wallet, mainBalance: balance, history }
}
