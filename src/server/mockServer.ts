// Servidor simulado dentro del navegador: emite certificados y liquida. Cada paso queda en
// la bitácora (trace) para que la vista "Por dentro" lo anime con los datos reales.

import { exportPublicKey, generateSigningKey, randomBytes, toB64url, toHex } from '../crypto/primitives'
import {
  MAX_PAYMENTS,
  OFFLINE_LIMIT,
  WINDOW_MS,
  checkPaymentRules,
  receiptMatches,
  rejectMessage,
  seal,
  verifyReceiptQr,
  verifySignedPayment,
  type DeviceCert,
  type StoreCert,
  type VerifiedPayment,
} from '../protocol'
import { short, trace, type Check, type LedgerLine } from '../trace'
import { deviceCertFields, money } from '../inside/describe'

export type SettleResult = { status: 'confirmado' } | { status: 'esperando' } | { status: 'rechazado'; reason: string }

export interface Upload {
  /** Pago firmado por el celular (ya descifrado, viaja por TLS). */
  payment: string
  receipt?: string
}

export interface Activation {
  cert: DeviceCert
  /** Certificado firmado por la raíz, va dentro de cada QR de pago. */
  certEnv: string
  balance: number
}

interface User {
  name: string
  balance: number
}

interface Entry {
  storeId: string
  amount: number
}

interface OfflineWindow {
  userId: string
  deviceId: string
  limit: number
  closed: boolean
  /** Pagos ya liquidados a la tienda. */
  settled: Map<number, Entry>
  /** Pagos que el cliente reportó, pero que la tienda aún no sube. Su plata sigue reservada. */
  held: Map<number, Entry>
}

interface Store {
  name: string
  balance: number
}

const network = () => new Promise((r) => setTimeout(r, 450 + Math.random() * 350))
const id = (prefix: string) => `${prefix}-${toHex(randomBytes(4))}`
const sum = (m: Map<number, Entry>) => [...m.values()].reduce((t, e) => t + e.amount, 0)
const reject = (reason: string): SettleResult => ({ status: 'rechazado', reason })
const reserve = (w: string) => `Reserva sin internet ${w}`

function resultCheck(s: number, amount: number, r: SettleResult): Check {
  const label = `Pago ${s} · ${money(amount)}`
  if (r.status === 'confirmado') return { label, state: 'ok', detail: 'Liquidado' }
  if (r.status === 'esperando') return { label, state: 'wait', detail: 'Reservado: espera a que la tienda lo suba' }
  return { label, state: 'fail', detail: r.reason }
}

export class MockServer {
  /** En producción la privada vive en AWS KMS y nunca sale de ahí. */
  private root!: CryptoKeyPair
  private users = new Map<string, User>()
  private windows = new Map<string, OfflineWindow>()
  private stores = new Map<string, Store>()
  private listeners = new Set<() => void>()

  static async create(): Promise<MockServer> {
    const server = new MockServer()
    server.root = await generateSigningKey()
    return server
  }

  /** La llave pública raíz que viene incluida en las apps. */
  get rootPublicKey(): CryptoKey {
    return this.root.publicKey
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    this.listeners.forEach((fn) => fn())
  }

  registerUser(userId: string, name: string, balance: number) {
    this.users.set(userId, { name, balance })
  }

  async registerStore(storeId: string, name: string, llave: string, signKey: CryptoKey, encryptKey: CryptoKey): Promise<string> {
    this.stores.set(storeId, { name, balance: 0 })
    const pk = toB64url(await exportPublicKey(signKey))
    const ek = toB64url(await exportPublicKey(encryptKey))
    return seal<StoreCert>({ id: storeId, name, llave, pk, ek }, this.root.privateKey)
  }

  async activateOffline(userId: string, deviceId: string, devicePublicKey: CryptoKey): Promise<Activation> {
    await network()
    const user = this.users.get(userId)
    if (!user) throw new Error('Usuario no existe')
    if (user.balance < OFFLINE_LIMIT) throw new Error('Saldo insuficiente para reservar el cupo')

    user.balance -= OFFLINE_LIMIT
    const cert: DeviceCert = {
      u: userId,
      nm: user.name,
      d: deviceId,
      w: id('w'),
      pk: toB64url(await exportPublicKey(devicePublicKey)),
      lim: OFFLINE_LIMIT,
      max: MAX_PAYMENTS,
      exp: Date.now() + WINDOW_MS,
    }
    this.windows.set(cert.w, { userId, deviceId, limit: OFFLINE_LIMIT, closed: false, settled: new Map(), held: new Map() })
    const certEnv = await seal(cert, this.root.privateKey)

    trace.emit({
      actor: 'server',
      title: 'Nubank reserva el cupo y firma el certificado',
      text: `Mueve ${money(OFFLINE_LIMIT)} del saldo a una reserva en el ledger y le pide al KMS que firme el certificado con la llave raíz. El certificado amarra la llave pública del celular a este cupo: monto, número de pagos y vencimiento.`,
      hops: [['allowance', 'ledger'], ['allowance', 'kms'], ['kms', 'allowance'], ['allowance', 'payer']],
      packet: 'certificado',
      crypto: ['Firma ECDSA P-256', 'Llave raíz · nunca sale del KMS'],
      ledger: [
        { account: `${user.name} · cuenta`, amount: -OFFLINE_LIMIT },
        { account: reserve(cert.w), amount: OFFLINE_LIMIT },
      ],
      blocks: [
        { title: 'Certificado del cupo', fields: deviceCertFields(cert) },
        { title: 'Firma de Nubank', fields: [{ k: 'firma', v: short(certEnv.split('.')[1]), note: '64 B · ECDSA P-256 sobre el certificado' }] },
      ],
      code: 'clj-activate',
    })
    return { cert, certEnv, balance: user.balance }
  }

  /** La tienda sube los pagos que aceptó, con o sin internet en ese momento. */
  async uploadStorePayments(storeId: string, uploads: Upload[]): Promise<SettleResult[]> {
    await network()
    const entries: LedgerLine[] = []
    const results: SettleResult[] = []
    const checks: Check[] = []
    for (const u of uploads) {
      // El comprobante firmado por la tienda autentica quién sube el pago.
      const receipt = u.receipt ? await verifyReceiptQr(u.receipt, this.rootPublicKey) : null
      const v = await verifySignedPayment(u.payment, this.rootPublicKey)
      let r: SettleResult
      if (!v.ok) r = reject(rejectMessage[v.reason])
      else if (!receipt || receipt.store.id !== storeId || !receiptMatches(receipt, v.payment)) r = reject('La tienda no pudo autenticarse.')
      else r = this.settle(v.payment, entries)
      results.push(r)
      if (v.ok) checks.push(resultCheck(v.payment.body.s, v.payment.body.a, r))
    }

    const store = this.stores.get(storeId)
    const moved = entries.length > 0
    trace.emit({
      actor: 'server',
      title: moved ? 'Nubank verifica y liquida a la tienda' : 'Nubank verifica lo que subió la tienda',
      text: `Repite la misma cadena de firmas que hizo la tienda y además revisa el cupo en la base de datos: cada pago del cupo se liquida una sola vez. ${moved ? 'Mueve la plata de la reserva del cliente a la cuenta de la tienda y publica el evento en Kafka para avisarle al cliente.' : 'No hubo movimientos nuevos.'}`,
      hops: moved ? [['settlement', 'ledger'], ['settlement', 'payer']] : [['settlement', 'store']],
      packet: moved ? 'liquidado' : 'respuesta',
      crypto: ['Verificación ECDSA', 'Comprobante = autenticación de la tienda'],
      checks,
      ledger: moved ? entries : undefined,
      blocks: [{ title: 'Respuesta a la tienda', text: `${store?.name ?? storeId} · saldo ${money(store?.balance ?? 0)}` }],
      code: 'clj-settle',
      status: checks.some((c) => c.state === 'fail') ? 'error' : 'ok',
    })
    this.emit()
    return results
  }

  /** El cliente sincroniza: sube todo lo que generó, cierra el cupo y recupera lo no usado. */
  async syncPayer(userId: string, windowId: string, uploads: Upload[]) {
    await network()
    const user = this.users.get(userId)
    const win = this.windows.get(windowId)
    if (!user || !win || win.userId !== userId) throw new Error('Cupo no encontrado')

    const entries: LedgerLine[] = []
    const statuses: Record<number, SettleResult> = {}
    const checks: Check[] = []
    for (const u of uploads) {
      const v = await verifySignedPayment(u.payment, this.rootPublicKey)
      if (!v.ok || v.payment.cert.w !== windowId) continue
      const { body } = v.payment
      const receipt = u.receipt ? await verifyReceiptQr(u.receipt, this.rootPublicKey) : null

      if (win.settled.has(body.s) || (receipt && receiptMatches(receipt, v.payment))) {
        statuses[body.s] = this.settle(v.payment, entries)
      } else if (sum(win.settled) + sum(win.held) + body.a > win.limit) {
        statuses[body.s] = reject(rejectMessage.saldo)
      } else {
        win.held.set(body.s, { storeId: body.st, amount: body.a })
        statuses[body.s] = { status: 'esperando' }
      }
      checks.push(resultCheck(body.s, body.a, statuses[body.s]))
    }

    win.closed = true
    const refund = win.limit - sum(win.settled) - sum(win.held)
    user.balance += refund
    if (refund > 0) entries.push({ account: reserve(windowId), amount: -refund }, { account: `${user.name} · cuenta`, amount: refund })

    trace.emit({
      actor: 'server',
      title: 'Nubank cierra el cupo y devuelve lo no usado',
      text: 'Los pagos con comprobante de la tienda se liquidan ya. Los que no tienen comprobante quedan reservados hasta que la tienda los suba. El cupo se cierra: cualquier pago de este cupo que aparezca después sin haber sido reportado es un intento de doble gasto.',
      hops: [['settlement', 'ledger'], ['settlement', 'allowance'], ['settlement', 'payer']],
      packet: 'cupo cerrado',
      crypto: ['Verificación ECDSA', 'Cierre del cupo'],
      checks,
      ledger: entries,
      blocks: [{ title: 'Respuesta al cliente', fields: [{ k: 'devuelto', v: money(refund), note: 'cupo no usado' }, { k: 'saldo', v: money(user.balance) }] }],
      code: 'clj-sync',
    })
    this.emit()
    return { statuses, refund, balance: user.balance }
  }

  /** Liquida un pago y anota sus asientos en `entries`. */
  private settle(p: VerifiedPayment, entries: LedgerLine[]): SettleResult {
    const { cert, body } = p
    const win = this.windows.get(cert.w)
    if (!win || win.userId !== cert.u || win.deviceId !== cert.d) return reject('No reconocemos este cupo.')
    const rule = checkPaymentRules(p, body.st, body.ts)
    if (rule) return reject(rejectMessage[rule])

    const done = win.settled.get(body.s)
    if (done) {
      return done.storeId === body.st && done.amount === body.a
        ? { status: 'confirmado' }
        : reject('Doble gasto: este pago ya se liquidó con otra tienda.')
    }

    const held = win.held.get(body.s)
    if (held && (held.storeId !== body.st || held.amount !== body.a)) return reject('Doble gasto: no coincide con lo que reportó el cliente.')
    if (!held && win.closed) return reject('El cliente no reportó este pago: posible doble gasto.')
    if (!held && sum(win.settled) + sum(win.held) + body.a > win.limit) return reject(rejectMessage.saldo)

    win.held.delete(body.s)
    win.settled.set(body.s, { storeId: body.st, amount: body.a })
    const store = this.stores.get(body.st)
    if (store) store.balance += body.a
    entries.push({ account: reserve(cert.w), amount: -body.a }, { account: `${store?.name ?? body.st} · cuenta`, amount: body.a })
    return { status: 'confirmado' }
  }

  /** Estado actual de los pagos del cliente, para refrescar su app cuando la tienda liquida después. */
  paymentStatuses(userId: string) {
    const statuses: Record<string, 'confirmado' | 'esperando'> = {}
    for (const [w, win] of this.windows) {
      if (win.userId !== userId) continue
      win.settled.forEach((_, s) => (statuses[`${w}:${s}`] = 'confirmado'))
      win.held.forEach((_, s) => (statuses[`${w}:${s}`] = 'esperando'))
    }
    return { statuses, balance: this.users.get(userId)?.balance ?? 0 }
  }
}
