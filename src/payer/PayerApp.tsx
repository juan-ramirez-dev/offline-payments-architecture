import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { exportPublicKey, generateSigningKey, toB64url } from '../crypto/primitives'
import type { MockServer } from '../server/mockServer'
import { OFFLINE_LIMIT, formatMoney, peek, readStoreQr, verifyReceiptQr, type StoreCert } from '../protocol'
import { short, trace } from '../trace'
import { paymentFields, paymentQrBlock, receiptFields, signedPaymentBlock, storeCertFields } from '../inside/describe'
import {
  applyActivation,
  applyStatuses,
  attachReceipt,
  createOfflinePayment,
  payBlockReason,
  settleWindow,
  type LocalPayment,
  type PayBlock,
  type Wallet,
} from './wallet'
import { QrImage } from '../components/QrImage'
import { Scanner } from '../components/Scanner'
import { Keypad } from '../components/Keypad'
import { BackIcon, CheckIcon, ClockIcon, EyeIcon, QrIcon, ScanIcon, ShieldIcon, SyncIcon } from '../components/icons'

type Screen =
  | { name: 'home' }
  | { name: 'scan'; mode: 'store' }
  | { name: 'scan'; mode: 'receipt'; seq: number }
  | { name: 'amount'; store: StoreCert }
  | { name: 'generating' }
  | { name: 'qr'; seq: number }
  | { name: 'syncing' }
  | { name: 'synced'; payments: LocalPayment[]; refund: number; renewed: boolean }

interface Props {
  server: MockServer
  /** Llave pública raíz incluida en la app: permite verificar tiendas y comprobantes sin internet. */
  rootKey: CryptoKey
  wallet: Wallet
  setWallet: Dispatch<SetStateAction<Wallet>>
  online: boolean
  /** Lo que muestra la pantalla de la tienda (su QR de cobro o un comprobante). */
  visibleStoreQr: string | null
  /** El QR de pago tal como se ve en pantalla (puede estar alterado en modo prueba). */
  displayedQr: string | null
  tampered: boolean
  onShowQr: (qr: string | null) => void
}

const blockMessage: Record<PayBlock, string> = {
  'sin-cupo': 'Primero activa Pagos sin internet.',
  'limite-pagos': 'Ya usaste tus 3 pagos sin internet. Conéctate para renovarlos.',
  vencido: 'Tu cupo sin internet venció. Conéctate para renovarlo.',
  'sin-saldo': 'Ya no tienes saldo sin internet. Conéctate para renovarlo.',
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false })
const dateTime = (ts: number) =>
  new Date(ts).toLocaleString('es-EC', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export function PayerApp({ server, rootKey, wallet, setWallet, online, visibleStoreQr, displayedQr, tampered, onShowQr }: Props) {
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null)
  const [amount, setAmount] = useState(0)
  const walletRef = useRef(wallet)
  walletRef.current = wallet
  const onlineRef = useRef(online)
  onlineRef.current = online
  const storeQrRef = useRef(visibleStoreQr)
  storeQrRef.current = visibleStoreQr

  const notify = (msg: string) => setToast({ id: Date.now(), msg })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const shown = screen.name === 'qr' ? wallet.offline?.payments.find((p) => p.seq === screen.seq) : undefined
  useEffect(() => {
    onShowQr(shown?.qr ?? null)
  }, [shown?.qr, onShowQr])

  // Cuando la tienda liquida un pago en espera, el cliente lo ve confirmado (si tiene internet).
  useEffect(
    () =>
      server.subscribe(() => {
        if (!onlineRef.current) return
        const { statuses, balance } = server.paymentStatuses(walletRef.current.userId)
        setWallet((w) => applyStatuses(w, statuses, balance))
      }),
    [server, setWallet],
  )

  // Al recuperar internet se suben los pagos, se cierra el cupo y se renueva.
  const prevOnline = useRef(online)
  useEffect(() => {
    const wasOnline = prevOnline.current
    prevOnline.current = online
    const w = walletRef.current
    if (wasOnline || !online || !w.offline || w.offline.payments.length === 0) return
    void sync(w)
  }, [online])

  async function renew(w: Wallet): Promise<Wallet> {
    const keys = await generateSigningKey()
    const pk = toB64url(await exportPublicKey(keys.publicKey))
    trace.emit({
      actor: 'payer',
      title: w.history.length ? 'El celular crea llaves nuevas para el siguiente cupo' : 'El celular crea su par de llaves',
      text: 'Genera un par ECDSA P-256 dentro del celular. La llave privada nunca sale de ahí (en un celular real vive en el Secure Enclave o StrongBox); solo la pública viaja a Nubank, por TLS. Cada cupo usa llaves nuevas.',
      hops: [['payer', 'allowance']],
      packet: 'llave pública',
      crypto: ['Genera llaves ECDSA P-256', 'Privada: no exportable'],
      blocks: [{ title: 'Solicitud de activación (TLS)', fields: [{ k: 'u', v: w.userId, note: 'cliente autenticado' }, { k: 'd', v: w.deviceId, note: 'id del celular' }, { k: 'pk', v: short(pk), note: 'llave pública · 65 B' }] }],
      code: 'ts-keygen',
    })
    return applyActivation(w, await server.activateOffline(w.userId, w.deviceId, keys.publicKey), keys.privateKey)
  }

  async function sync(w: Wallet) {
    const off = w.offline!
    setScreen({ name: 'syncing' })
    trace.emit({
      actor: 'payer',
      title: 'Volvió el internet: el cliente sincroniza',
      text: 'Sube todos los pagos que firmó en este cupo, con los comprobantes que alcanzó a escanear. Así Nubank sabe exactamente cuánto gastó y puede cerrar el cupo, aunque la tienda siga sin señal.',
      hops: [['payer', 'settlement']],
      packet: `${off.payments.length} ${off.payments.length === 1 ? 'pago' : 'pagos'}`,
      crypto: ['TLS 1.3', 'Pagos firmados por el celular'],
      blocks: [{ title: 'Lo que sube', fields: off.payments.map((p) => ({ k: `pago ${p.seq}`, v: p.amount, note: `${p.storeName} · ${p.receipt ? 'con comprobante' : 'sin comprobante'}` })) }],
    })
    const res = await server.syncPayer(w.userId, off.windowId, off.payments.map((p) => ({ payment: p.signed, receipt: p.receipt })))
    let next = settleWindow(w, res.statuses, res.balance)
    let renewed = true
    try {
      next = await renew(next)
    } catch {
      renewed = false
    }
    setWallet(next)
    setScreen({ name: 'synced', payments: next.history.filter((p) => p.windowId === off.windowId), refund: res.refund, renewed })
  }

  async function activate() {
    if (!online) return notify('Necesitas internet para activar y recibir tu certificado.')
    setBusy(true)
    try {
      setWallet(await renew(wallet))
      notify(`Listo: ${formatMoney(OFFLINE_LIMIT)} reservados para pagar sin internet.`)
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function startPay() {
    const block = payBlockReason(wallet.offline)
    if (block) return notify(blockMessage[block])
    if (online) return notify('Tienes internet: este pago iría por el flujo normal. Apaga el internet para probar el modo sin conexión.')
    setScreen({ name: 'scan', mode: 'store' })
  }

  async function onStoreScanned() {
    const text = storeQrRef.current
    const store = text ? await readStoreQr(text, rootKey) : null
    const claimed = text?.startsWith('TIENDA.') ? peek<StoreCert>(text.slice(7).split('.')[0]) : null
    if (claimed) {
      trace.emit({
        actor: 'payer',
        title: store ? 'El cliente verifica a la tienda, sin internet' : 'El QR de la tienda no es auténtico',
        text: 'El QR de la tienda trae su certificado, firmado por Nubank. La app trae la llave pública raíz de Nubank, así que puede comprobarlo sin internet. Del certificado saca la llave con la que va a cifrar el pago.',
        hops: [['store', 'payer']],
        packet: 'QR tienda',
        crypto: ['Verificación ECDSA', 'Llave raíz incluida en la app'],
        checks: [{ label: 'Nubank firmó el certificado de la tienda', state: store ? 'ok' : 'fail' }],
        blocks: [{ title: 'Certificado de la tienda', fields: storeCertFields(claimed) }],
        status: store ? 'ok' : 'error',
      })
    }
    if (!store) {
      setScreen({ name: 'home' })
      return notify(
        text?.startsWith('TIENDA.')
          ? 'Este QR no es de una tienda verificada.'
          : 'No encontramos el QR de cobro. La tienda debe estar en su pantalla principal.',
      )
    }
    setAmount(0)
    setScreen({ name: 'amount', store })
  }

  async function onReceiptScanned(seq: number) {
    const text = storeQrRef.current
    const receipt = text ? await verifyReceiptQr(text, rootKey) : null
    const off = walletRef.current.offline
    setScreen({ name: 'qr', seq })
    if (!text || !receipt || !off || receipt.body.w !== off.windowId || receipt.body.s !== seq) {
      return notify('No encontramos el comprobante de este pago en la pantalla de la tienda.')
    }
    setWallet((w) => attachReceipt(w, seq, text))
    trace.emit({
      actor: 'payer',
      title: 'El cliente guarda el comprobante de la tienda',
      text: 'Verifica la cadena Nubank → tienda → comprobante y que corresponda a su pago. Ahora el cliente tiene prueba firmada de que la tienda aceptó, y puede liquidar el pago él mismo apenas tenga internet.',
      hops: [['store', 'payer']],
      packet: 'comprobante',
      crypto: ['Verificación ECDSA', 'Llave de la tienda (de su certificado)'],
      checks: [
        { label: 'Nubank firmó el certificado de la tienda', state: 'ok' },
        { label: 'La tienda firmó el comprobante', state: 'ok' },
        { label: `Es de mi pago: cupo ${receipt.body.w}, pago ${receipt.body.s}`, state: 'ok' },
      ],
      blocks: [{ title: 'Comprobante', fields: receiptFields(receipt.body) }],
    })
    notify('Comprobante verificado: la tienda aceptó tu pago.')
  }

  async function generate(store: StoreCert) {
    setScreen({ name: 'generating' })
    const res = await createOfflinePayment(walletRef.current, store, amount)
    trace.emit({
      actor: 'payer',
      title: 'El celular firma y cifra el pago',
      text: `Firma el pago con su llave privada y lo cifra solo para ${store.name}: un acuerdo ECDH con la llave de cifrado de la tienda (con una llave efímera nueva) da una llave AES-256-GCM. Descuenta ${formatMoney(res.body.a)} de su saldo sin internet antes de mostrar el QR.`,
      crypto: ['Firma ECDSA P-256', 'Cifrado ECDH + HKDF + AES-256-GCM'],
      blocks: [
        { title: 'Pago', fields: paymentFields(res.body) },
        signedPaymentBlock(res.payment.signed),
        paymentQrBlock(res.payment.qr),
      ],
      code: 'ts-pay',
    })
    await new Promise((r) => setTimeout(r, 900))
    setWallet(res.wallet)
    setScreen({ name: 'qr', seq: res.payment.seq })
  }

  return (
    <div className="app payer">
      {screen.name === 'home' && <Home wallet={wallet} online={online} busy={busy} onActivate={activate} onPay={startPay} />}

      {screen.name === 'scan' && (
        <Scanner
          hint={screen.mode === 'store' ? 'Apunta al QR de la tienda' : 'Escanea el comprobante de la tienda'}
          onDone={() => (screen.mode === 'store' ? onStoreScanned() : onReceiptScanned(screen.seq))}
          onCancel={() => setScreen(screen.mode === 'store' ? { name: 'home' } : { name: 'qr', seq: screen.seq })}
        />
      )}

      {screen.name === 'amount' && wallet.offline && (
        <AmountScreen
          store={screen.store}
          amount={amount}
          setAmount={setAmount}
          available={wallet.offline.balance}
          seq={wallet.offline.seq + 1}
          max={wallet.offline.maxPayments}
          onBack={() => setScreen({ name: 'home' })}
          onConfirm={() => generate(screen.store)}
        />
      )}

      {screen.name === 'generating' && (
        <div className="center-state">
          <div className="lock-anim"><ShieldIcon size={34} /></div>
          <p className="center-state__title">Firmando tu pago</p>
          <p className="muted">Con la llave privada de este celular</p>
        </div>
      )}

      {screen.name === 'qr' && shown && wallet.offline && (
        <div className="screen pay-qr">
          <p className="pay-qr__title">Muestra este QR Bre-B a la tienda</p>
          <div className={`pay-qr__code ${tampered ? 'is-tampered' : ''} ${shown.status === 'aceptado' ? 'is-accepted' : ''}`}>
            {displayedQr && <QrImage text={displayedQr} size={196} label="Código QR de pago" />}
            {tampered && <span className="tamper-badge">Monto alterado</span>}
          </div>
          <strong className="pay-qr__amount">{formatMoney(shown.amount)}</strong>
          <p className="muted">para {shown.storeName} · {shown.storeLlave}</p>
          <div className="pay-qr__meta">
            <span className="chip">Pago {shown.seq} de {wallet.offline.maxPayments}</span>
            <span className="chip">Te quedan {formatMoney(wallet.offline.balance)}</span>
          </div>
          {shown.status === 'aceptado' ? (
            <div className="note note--ok">
              <CheckIcon size={14} />
              <span>La tienda aceptó tu pago. Se hará efectivo cuando cualquiera de los dos tenga internet.</span>
            </div>
          ) : (
            <>
              <div className="note">
                <ClockIcon />
                <span>Cuando la tienda acepte el pago, escanea su comprobante.</span>
              </div>
              <button type="button" className="btn btn--ghost btn--block btn--icon" onClick={() => setScreen({ name: 'scan', mode: 'receipt', seq: shown.seq })}>
                <ScanIcon size={18} /> Escanear comprobante
              </button>
            </>
          )}
          <button type="button" className="btn btn--primary btn--block" onClick={() => setScreen({ name: 'home' })}>
            Listo
          </button>
        </div>
      )}

      {screen.name === 'syncing' && (
        <div className="center-state">
          <div className="spin"><SyncIcon size={30} /></div>
          <p className="center-state__title">Sincronizando</p>
          <p className="muted">Subiendo tus pagos sin internet</p>
        </div>
      )}

      {screen.name === 'synced' && (
        <div className="screen synced">
          <div className="result-icon result-icon--ok"><CheckIcon size={30} /></div>
          <p className="center-state__title">Todo sincronizado</p>
          <ul className="mov-list">
            {screen.payments.map((p) => (
              <MovementItem key={p.seq} p={p} />
            ))}
          </ul>
          {screen.payments.some((p) => p.status === 'esperando') && (
            <p className="muted small">Los pagos en espera se harán efectivos cuando la tienda se conecte.</p>
          )}
          {screen.refund > 0 && <p className="muted small">Volvieron {formatMoney(screen.refund)} sin usar a tu cuenta.</p>}
          <p className="muted small">
            {screen.renewed
              ? `Tu cupo de ${formatMoney(OFFLINE_LIMIT)} sin internet se renovó con una llave nueva.`
              : 'No pudimos renovar tu cupo: saldo insuficiente.'}
          </p>
          <button type="button" className="btn btn--primary btn--block" onClick={() => setScreen({ name: 'home' })}>
            Entendido
          </button>
        </div>
      )}

      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.msg}
        </div>
      )}
    </div>
  )
}

function Home({ wallet, online, busy, onActivate, onPay }: { wallet: Wallet; online: boolean; busy: boolean; onActivate: () => void; onPay: () => void }) {
  const off = wallet.offline
  const movements = [...(off?.payments ?? [])].reverse().concat(wallet.history)

  return (
    <div className="screen home">
      <header className="payer__top">
        <div className="payer__top-row">
          <span className="avatar">{wallet.name[0]}</span>
          <span className="payer__top-icons"><EyeIcon /></span>
        </div>
        <p className="payer__hello">Hola, {wallet.name}</p>
        <span className="llave llave--light">Llave Bre-B · {wallet.llave}</span>
      </header>

      <section className="p-block">
        <span className="p-block__label">Cuenta</span>
        <strong className="p-block__amount">{formatMoney(wallet.mainBalance)}</strong>
        <span className="muted small">{online ? 'Saldo disponible' : 'Último saldo conocido'}</span>
      </section>

      <section className={`offline-card ${off ? 'is-active' : ''}`}>
        <div className="offline-card__head">
          <span className="offline-card__title">Pagos sin internet</span>
          {off && <span className="badge">{online ? 'Listo' : 'En uso'}</span>}
        </div>

        {!off ? (
          <>
            <p className="offline-card__text">
              Reserva {formatMoney(OFFLINE_LIMIT)} de tu saldo para seguir pagando con QR Bre-B aunque no tengas señal.
            </p>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={onActivate}>
              {busy ? 'Activando…' : 'Activar'}
            </button>
          </>
        ) : (
          <>
            <div className="offline-card__balance">
              <strong>{formatMoney(off.balance)}</strong>
              <span className="muted small">de {formatMoney(off.limit)}</span>
            </div>
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${(off.balance / off.limit) * 100}%` }} />
            </div>
            <div className="offline-card__foot">
              <span className="dots" aria-label={`${off.seq} de ${off.maxPayments} pagos usados`}>
                {Array.from({ length: off.maxPayments }, (_, i) => (
                  <span key={i} className={i < off.seq ? 'is-used' : ''} />
                ))}
                <span className="small">{off.maxPayments - off.seq} pagos disponibles</span>
              </span>
              <span className="small muted">Vence {dateTime(off.expiresAt)}</span>
            </div>
          </>
        )}
      </section>

      <button type="button" className={`pay-action ${off ? '' : 'is-disabled'}`} onClick={onPay}>
        <span className="pay-action__icon"><QrIcon /></span>
        <span>Pagar con QR</span>
      </button>

      {movements.length > 0 && (
        <section className="p-movements">
          <span className="p-block__label">Pagos sin internet</span>
          <ul className="mov-list">
            {movements.map((p) => (
              <MovementItem key={`${p.windowId}-${p.seq}`} p={p} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

const statusLabel = {
  pendiente: 'Pendiente',
  aceptado: 'Aceptado por la tienda',
  confirmado: 'Confirmado',
  esperando: 'Esperando a la tienda',
  rechazado: 'Rechazado',
} as const

function MovementItem({ p }: { p: LocalPayment }) {
  return (
    <li className="mov">
      <div>
        <span className="mov__name">{p.storeName}</span>
        <span className="small muted">Pago {p.seq} · {time(p.createdAt)}</span>
      </div>
      <div className="mov__right">
        <span className={`mov__amount ${p.status === 'rechazado' ? 'is-void' : ''}`}>−{formatMoney(p.amount)}</span>
        <span className={`status status--${p.status}`}>{statusLabel[p.status]}</span>
      </div>
    </li>
  )
}

interface AmountProps {
  store: StoreCert
  amount: number
  setAmount: (v: number) => void
  available: number
  seq: number
  max: number
  onBack: () => void
  onConfirm: () => void
}

function AmountScreen({ store, amount, setAmount, available, seq, max, onBack, onConfirm }: AmountProps) {
  const tooMuch = amount > available
  return (
    <div className="screen amount">
      <header className="bar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Volver"><BackIcon /></button>
        <span className="bar__title">Pagar a {store.name}</span>
        <span className="verified" title="Tienda verificada"><ShieldIcon size={16} /></span>
      </header>
      <span className="llave">Llave Bre-B · {store.llave}</span>
      <p className="amount__q">¿Cuánto vas a pagar?</p>
      <strong className={`amount__value ${tooMuch ? 'is-error' : ''}`}>{formatMoney(amount)}</strong>
      <p className={`small ${tooMuch ? 'error-text' : 'muted'}`}>
        {tooMuch ? 'Saldo sin internet insuficiente' : `Disponible sin internet: ${formatMoney(available)}`}
      </p>
      <span className="chip">Pago {seq} de {max}</span>
      <Keypad value={amount} onChange={setAmount} />
      <button type="button" className="btn btn--primary btn--block" disabled={amount === 0 || tooMuch} onClick={onConfirm}>
        Generar código de pago
      </button>
    </div>
  )
}
