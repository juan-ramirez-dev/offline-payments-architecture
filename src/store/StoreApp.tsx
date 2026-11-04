import { useEffect, useRef, useState } from 'react'
import type { MockServer } from '../server/mockServer'
import {
  decryptPaymentQr,
  encodeReceiptQr,
  formatMoney,
  inspectSignedPayment,
  paymentId,
  paymentRuleResults,
  rejectMessage,
  type ReceiptBody,
  type RejectReason,
} from '../protocol'
import { trace, type Check } from '../trace'
import { paymentFields, paymentQrBlock, receiptFields, signedPaymentBlock } from '../inside/describe'
import { QrImage } from '../components/QrImage'
import { Scanner } from '../components/Scanner'
import { CheckIcon, ClockIcon, ScanIcon, ShieldIcon, StoreIcon, SyncIcon, XIcon } from '../components/icons'

export interface StoreInfo {
  id: string
  name: string
  llave: string
  /** Certificado de la tienda firmado por la raíz. */
  certEnv: string
  /** Llave privada de la tienda, con la que firma los comprobantes. */
  signingKey: CryptoKey
  /** Llave privada de cifrado: solo con ella se abren los pagos para esta tienda. */
  decryptKey: CryptoKey
  qr: string
}

export type SaleStatus = 'por-liquidar' | 'confirmado' | 'rechazado'

export interface StoreSale {
  id: string
  amount: number
  payerName: string
  seq: number
  at: number
  /** Pago firmado por el cliente, ya descifrado. */
  payment: string
  receipt: string
  status: SaleStatus
  reason?: string
}

/** Lo que la app de la tienda guarda en el celular. */
export interface StoreLocal {
  seen: string[]
  sales: StoreSale[]
}

type Screen =
  | { name: 'home' }
  | { name: 'scan' }
  | { name: 'validating' }
  | { name: 'accepted'; sale: StoreSale }
  | { name: 'rejected'; message: string }

interface Props {
  server: MockServer
  rootKey: CryptoKey
  store: StoreInfo
  local: StoreLocal
  setLocal: (fn: (l: StoreLocal) => StoreLocal) => void
  online: boolean
  /** Lo que muestra la pantalla del cliente (si es un QR de pago). */
  visiblePayerQr: string | null
  onShowQr: (qr: string | null) => void
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ruleLabel = {
  'otra-tienda': 'Va para esta tienda',
  vencido: 'El cupo está vigente',
  'limite-pagos': 'No supera los pagos permitidos',
  saldo: 'El saldo cuadra: b0 − a = b1, dentro del cupo',
} as const

/** Los pasos que sigue la tienda, en orden. Después del primero que falla ya no revisa más. */
async function validate(qr: string, store: StoreInfo, rootKey: CryptoKey, seen: string[]) {
  const checks: Check[] = []
  let failed: RejectReason | null = null
  const step = (label: string, ok: boolean, reason: RejectReason, detail?: string) => {
    checks.push({ label, state: failed ? 'skip' : ok ? 'ok' : 'fail', detail: !failed && !ok ? detail : undefined })
    if (!failed && !ok) failed = reason
  }

  const signed = await decryptPaymentQr(qr, store.decryptKey)
  step('Se descifra con la llave privada de la tienda', !!signed, qr.startsWith('PAGO.') ? 'otra-tienda' : 'formato', 'No está cifrado para esta tienda')
  const p = signed ? await inspectSignedPayment(signed, rootKey) : null
  step('Nubank firmó el certificado del cliente', !!p?.certOk, 'alterado')
  step('El celular del certificado firmó este pago', !!p?.bodyOk, 'alterado', 'La firma no corresponde a estos datos: alguien los cambió')
  const payment = p?.cert && p.body ? { cert: p.cert, body: p.body } : null
  const rules = payment ? paymentRuleResults(payment, store.id) : []
  for (const r of ['otra-tienda', 'vencido', 'limite-pagos', 'saldo'] as const) {
    step(ruleLabel[r], rules.find((x) => x.rule === r)?.ok ?? false, r)
  }
  step('No se ha cobrado antes (registro local)', !!payment && !seen.includes(paymentId(payment)), 'reusado', 'Este pago ya está en el registro de la tienda')
  return { checks, failed: failed as RejectReason | null, signed, inspection: p, payment }
}

const statusLabel: Record<SaleStatus, string> = {
  'por-liquidar': 'Por liquidar',
  confirmado: 'Confirmado',
  rechazado: 'Rechazado',
}

export function StoreApp({ server, rootKey, store, local, setLocal, online, visiblePayerQr, onShowQr }: Props) {
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [syncing, setSyncing] = useState(false)
  const payerQrRef = useRef(visiblePayerQr)
  payerQrRef.current = visiblePayerQr
  const localRef = useRef(local)
  localRef.current = local
  const uploading = useRef(false)

  const acceptedSale = screen.name === 'accepted' ? local.sales.find((s) => s.id === screen.sale.id) ?? screen.sale : undefined

  useEffect(() => {
    onShowQr(screen.name === 'home' ? store.qr : screen.name === 'accepted' ? screen.sale.receipt : null)
  }, [screen, store.qr, onShowQr])

  async function upload(sales: StoreSale[]) {
    if (uploading.current || sales.length === 0) return
    uploading.current = true
    setSyncing(true)
    try {
      trace.emit({
        actor: 'store',
        title: 'La tienda tiene internet: sube sus cobros',
        text: 'Manda cada pago firmado por el cliente junto con su propio comprobante. El comprobante, firmado con la llave de la tienda, es lo que demuestra que quien cobra es la tienda a la que iba el pago.',
        hops: [['store', 'settlement']],
        packet: `${sales.length} ${sales.length === 1 ? 'cobro' : 'cobros'}`,
        crypto: ['TLS 1.3', 'Pago firmado + comprobante firmado'],
        blocks: [{ title: 'Lo que sube', fields: sales.map((s) => ({ k: `pago ${s.seq}`, v: s.amount, note: `de ${s.payerName}` })) }],
      })
      const results = await server.uploadStorePayments(store.id, sales.map((s) => ({ payment: s.payment, receipt: s.receipt })))
      setLocal((l) => ({
        ...l,
        sales: l.sales.map((x) => {
          const r = results[sales.findIndex((s) => s.id === x.id)]
          if (!r) return x
          return r.status === 'rechazado' ? { ...x, status: 'rechazado', reason: r.reason } : { ...x, status: 'confirmado' }
        }),
      }))
    } finally {
      uploading.current = false
      setSyncing(false)
    }
  }

  // Al tener internet, la tienda sube lo que aceptó sin conexión.
  useEffect(() => {
    if (online) void upload(localRef.current.sales.filter((s) => s.status === 'por-liquidar'))
  }, [online])

  async function onScanned() {
    const qr = payerQrRef.current
    if (!qr) return setScreen({ name: 'rejected', message: 'No detectamos un código de pago. Pide al cliente que muestre su QR.' })

    setScreen({ name: 'validating' })
    // Todo en este celular, sin internet: descifrar → raíz → certificado del cliente → firma del pago → reglas.
    const v = await validate(qr, store, rootKey, localRef.current.seen)
    const shown = v.inspection?.body
    trace.emit({
      actor: 'store',
      title: v.failed ? 'La tienda rechaza el pago, sin internet' : 'La tienda descifra y valida el pago, sin internet',
      text: v.failed
        ? 'La tienda revisa cada eslabón con la llave raíz de Nubank que trae la app. En cuanto uno falla, rechaza el pago: no necesita preguntarle a nadie.'
        : 'Abre el QR con su llave privada de cifrado y revisa la cadena: Nubank firmó el certificado del cliente, y ese certificado trae la llave pública que firmó el pago. Luego aplica las reglas del cupo. Todo localmente.',
      hops: [['payer', 'store']],
      packet: 'pago cifrado',
      crypto: ['Descifrado ECDH + AES-256-GCM', 'Verificación ECDSA × 2'],
      checks: v.checks,
      blocks: [
        paymentQrBlock(qr),
        ...(v.signed ? [signedPaymentBlock(v.signed)] : []),
        ...(shown ? [{ title: v.inspection?.bodyOk ? 'Pago' : 'Pago (no coincide con la firma)', fields: paymentFields(shown) }] : []),
      ],
      code: 'ts-verify',
      status: v.failed ? 'error' : 'ok',
    })
    await wait(900)
    if (v.failed || !v.payment || !v.signed) return setScreen({ name: 'rejected', message: rejectMessage[v.failed ?? 'formato'] })

    const { cert, body } = v.payment
    const id = paymentId(v.payment)
    const rb: ReceiptBody = { w: cert.w, s: body.s, st: store.id, a: body.a, ts: Date.now() }
    const receipt = await encodeReceiptQr(store.certEnv, rb, store.signingKey)
    const sale: StoreSale = { id, amount: body.a, payerName: cert.nm, seq: body.s, at: Date.now(), payment: v.signed, receipt, status: 'por-liquidar' }
    setLocal((l) => ({ seen: [...l.seen, id], sales: [sale, ...l.sales] }))
    setScreen({ name: 'accepted', sale })
    trace.emit({
      actor: 'store',
      title: 'La tienda firma un comprobante para el cliente',
      text: online
        ? 'Firma con su llave privada que aceptó este pago y lo muestra en QR. Como tiene internet, también lo sube de una vez.'
        : 'Firma con su llave privada que aceptó este pago y lo guarda como "por liquidar". El comprobante no lleva datos sensibles, así que va firmado pero no cifrado.',
      crypto: ['Firma ECDSA P-256', 'Llave privada de la tienda'],
      blocks: [{ title: 'Comprobante', fields: receiptFields(rb) }],
      code: 'ts-receipt',
    })
    if (online) void upload([sale])
  }

  const active = local.sales.filter((s) => s.status !== 'rechazado')
  const total = active.reduce((sum, s) => sum + s.amount, 0)
  const pending = active.filter((s) => s.status === 'por-liquidar').reduce((sum, s) => sum + s.amount, 0)

  return (
    <div className="app store">
      {screen.name === 'home' && (
        <div className="screen store-home">
          <header className="store__top">
            <div className="store__brand">
              <span className="store__logo"><StoreIcon /></span>
              <div>
                <span className="store__name">{store.name}</span>
                <span className="small store__sub">Cuenta de negocio</span>
              </div>
            </div>
            <div className="store__total">
              <span className="small store__sub">Ventas de hoy</span>
              <strong>{formatMoney(total)}</strong>
              {syncing ? (
                <span className="store__pill"><SyncIcon size={12} /> Liquidando…</span>
              ) : (
                pending > 0 && <span className="store__pill"><ClockIcon size={12} /> {formatMoney(pending)} por liquidar</span>
              )}
            </div>
          </header>

          <section className="store-qr">
            <QrImage text={store.qr} size={208} label={`QR de cobro de ${store.name}`} />
            <div>
              <span className="store-qr__title">Tu QR Bre-B de cobro</span>
              <span className="llave">Llave · {store.llave}</span>
              <span className="small muted">El cliente lo escanea y escribe el monto.</span>
            </div>
          </section>

          <button type="button" className="btn btn--dark btn--block btn--icon" onClick={() => setScreen({ name: 'scan' })}>
            <ScanIcon /> Escanear pago del cliente
          </button>

          <section className="store-sales">
            <span className="p-block__label">Últimos cobros</span>
            {local.sales.length === 0 ? (
              <p className="small muted">Aún no hay cobros.</p>
            ) : (
              <ul className="mov-list">
                {local.sales.map((s) => (
                  <li key={s.id} className="mov">
                    <div>
                      <span className="mov__name">{s.payerName}</span>
                      <span className="small muted">Sin internet · pago {s.seq} · {time(s.at)}</span>
                      {s.reason && <span className="small error-text">{s.reason}</span>}
                    </div>
                    <div className="mov__right">
                      <span className={`mov__amount ${s.status === 'rechazado' ? 'is-void' : 'is-in'}`}>+{formatMoney(s.amount)}</span>
                      <span className={`status status--${s.status}`}>{statusLabel[s.status]}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {screen.name === 'scan' && (
        <Scanner hint="Escanea el código de pago del cliente" onDone={onScanned} onCancel={() => setScreen({ name: 'home' })} />
      )}

      {screen.name === 'validating' && (
        <div className="center-state">
          <div className="lock-anim lock-anim--dark"><ShieldIcon size={34} /></div>
          <p className="center-state__title">Verificando firma</p>
          <p className="muted">{online ? 'Validando el pago' : 'Sin internet: se valida en este celular'}</p>
        </div>
      )}

      {screen.name === 'accepted' && acceptedSale && (
        <div className="screen store-accepted">
          {acceptedSale.status === 'rechazado' ? (
            <div className="result-icon result-icon--error"><XIcon size={30} /></div>
          ) : (
            <div className="result-icon result-icon--ok"><CheckIcon size={30} /></div>
          )}
          <p className="center-state__title">
            {acceptedSale.status === 'confirmado' ? 'Pago confirmado' : acceptedSale.status === 'rechazado' ? 'Pago rechazado' : 'Pago aceptado'}
          </p>
          <strong className="result-amount">{formatMoney(acceptedSale.amount)}</strong>
          <p className="muted small">de {acceptedSale.payerName} · pago {acceptedSale.seq} sin internet</p>
          <span className={`status status--${acceptedSale.status}`}>
            {acceptedSale.status === 'por-liquidar' ? (online ? 'Liquidando…' : 'Se liquida cuando tengas internet') : statusLabel[acceptedSale.status]}
          </span>
          {acceptedSale.reason && <p className="small error-text result-reason">{acceptedSale.reason}</p>}
          <div className="receipt">
            <QrImage text={acceptedSale.receipt} size={168} label="Comprobante para el cliente" />
            <span className="small muted">Comprobante para el cliente</span>
          </div>
          <button type="button" className="btn btn--dark btn--block" onClick={() => setScreen({ name: 'home' })}>
            Volver
          </button>
        </div>
      )}

      {screen.name === 'rejected' && (
        <div className="center-state">
          <div className="result-icon result-icon--error"><XIcon size={34} /></div>
          <p className="center-state__title">Pago rechazado</p>
          <p className="muted result-reason">{screen.message}</p>
          <button type="button" className="btn btn--dark btn--block" onClick={() => setScreen({ name: 'home' })}>
            Volver
          </button>
        </div>
      )}
    </div>
  )
}
