import { useCallback, useEffect, useState } from 'react'
import { exportPublicKey, generateEncryptionKey, generateSigningKey, randomBytes, sha256, toHex } from './crypto/primitives'
import { MockServer } from './server/mockServer'
import { OFFLINE_LIMIT, encodeStoreQr, encryptPaymentQr, formatMoney, peek, tamperSignedPayment, type PaymentBody, type StoreCert } from './protocol'
import type { Wallet } from './payer/wallet'
import { PayerApp } from './payer/PayerApp'
import { StoreApp, type StoreInfo, type StoreLocal } from './store/StoreApp'
import { Phone } from './components/Phone'
import { BackIcon, ShieldIcon, SyncIcon, WifiOffIcon } from './components/icons'
import { InsidePanel } from './inside/InsidePanel'
import { paymentFields, storeCertFields } from './inside/describe'
import { trace } from './trace'

const STORES = [
  { id: 'st-donpepe', name: 'Tienda Don Pepe', llave: '@tiendadonpepe' },
  { id: 'st-farmaluz', name: 'Farmacia Luz', llave: '@farmacialuz' },
]

interface Setup {
  server: MockServer
  stores: (StoreInfo & { cert: StoreCert })[]
  wallet: Wallet
}

type View = 'demo' | 'inside'
const INSIDE_HASH = '#por-dentro'

async function createSetup(): Promise<Setup> {
  const server = await MockServer.create()
  const wallet: Wallet = {
    userId: 'u-juan',
    deviceId: `dev-${toHex(randomBytes(4))}`,
    name: 'Juan',
    llave: '@juanramirez',
    mainBalance: 1_250_000,
    offline: null,
    history: [],
  }
  server.registerUser(wallet.userId, wallet.name, wallet.mainBalance)
  const stores = await Promise.all(
    STORES.map(async (s) => {
      const [sig, enc] = await Promise.all([generateSigningKey(), generateEncryptionKey()])
      const certEnv = await server.registerStore(s.id, s.name, s.llave, sig.publicKey, enc.publicKey)
      const cert = peek<StoreCert>(certEnv.split('.')[0])!
      return { ...s, cert, certEnv, signingKey: sig.privateKey, decryptKey: enc.privateKey, qr: encodeStoreQr(certEnv) }
    }),
  )
  return { server, stores, wallet }
}

/** Primer paso de la bitácora: lo que ya existe antes de que el cliente toque algo. */
async function traceSetup({ server, stores }: Setup) {
  const fp = toHex(await sha256(await exportPublicKey(server.rootPublicKey))).slice(0, 16)
  trace.emit({
    actor: 'server',
    title: 'Punto de partida: una sola llave raíz',
    text: 'Nubank guarda una llave raíz en un HSM (AWS KMS) que nunca sale de ahí. Con ella firmó el certificado de cada tienda al registrarla. La llave pública raíz viene dentro de ambas apps: con ella cada celular puede verificar al otro sin internet.',
    hops: [['kms', 'store']],
    packet: 'certificado',
    crypto: ['ECDSA P-256', 'Raíz pública incluida en las apps'],
    blocks: [
      { title: 'Llave pública raíz', fields: [{ k: 'sha-256', v: fp.match(/.{4}/g)!.join(':'), note: 'huella, igual en ambas apps' }] },
      { title: `Certificado de ${stores[0].name}`, fields: storeCertFields(stores[0].cert) },
    ],
    code: 'clj-root',
    status: 'info',
  })
}

export function App() {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [run, setRun] = useState(0)
  const [view, setViewState] = useState<View>(() => (location.hash === INSIDE_HASH ? 'inside' : 'demo'))

  const setView = (v: View) => {
    setViewState(v)
    history.replaceState(null, '', v === 'inside' ? INSIDE_HASH : location.pathname + location.search)
  }

  useEffect(() => {
    let alive = true
    createSetup().then(async (s) => {
      if (!alive) return
      trace.reset()
      await traceSetup(s)
      setSetup(s)
    })
    return () => {
      alive = false
    }
  }, [run])

  return setup ? (
    <Demo key={run} setup={setup} view={view} setView={setView} onReset={() => { setSetup(null); setRun((r) => r + 1) }} />
  ) : (
    <div className="page">
      <Hero />
      <p className="loading">Preparando la demo…</p>
    </div>
  )
}

function Hero() {
  return (
    <header className="hero">
      <span className="eyebrow">
        <span className="eyebrow__icon"><WifiOffIcon size={13} /></span>
        Bre-B · Concepto para Nubank
      </span>
      <h1>
        Pagos <span className="hero__accent">sin internet</span>
      </h1>
      <p className="hero__lead">
        Paga con QR Bre-B aunque no tengas señal. La tienda valida el pago sin conexión y se hace efectivo apenas
        cualquiera de los dos se conecte.
      </p>
      <ul className="hero__features">
        <li><span className="hero__icon"><WifiOffIcon size={16} /></span>Funciona sin señal en ambos celulares</li>
        <li><span className="hero__icon"><ShieldIcon size={16} /></span>Cada pago va firmado por el celular</li>
        <li><span className="hero__icon"><SyncIcon size={16} /></span>Se liquida con el primero que se conecte</li>
      </ul>
    </header>
  )
}

interface DemoProps {
  setup: Setup
  view: View
  setView: (v: View) => void
  onReset: () => void
}

function Demo({ setup, view, setView, onReset }: DemoProps) {
  const [wallet, setWallet] = useState(setup.wallet)
  const [payerOnline, setPayerOnline] = useState(true)
  const [storeOnline, setStoreOnline] = useState(true)
  const [storeIdx, setStoreIdx] = useState(0)
  const [storeLocals, setStoreLocals] = useState<Record<string, StoreLocal>>(() =>
    Object.fromEntries(setup.stores.map((s) => [s.id, { seen: [], sales: [] }])),
  )
  const [payerQr, setPayerQr] = useState<string | null>(null)
  const [storeQr, setStoreQr] = useState<string | null>(null)
  const [tampered, setTampered] = useState(false)
  const [tamperedQr, setTamperedQr] = useState<string | null>(null)

  const displayedQr = tampered ? tamperedQr : payerQr
  const store = setup.stores[storeIdx]
  const inside = view === 'inside'

  const handlePayerQr = useCallback((qr: string | null) => {
    setPayerQr(qr)
    setTampered(false)
  }, [])

  const setLocal = useCallback(
    (fn: (l: StoreLocal) => StoreLocal) => setStoreLocals((m) => ({ ...m, [store.id]: fn(m[store.id]) })),
    [store.id],
  )

  const shownPayment = wallet.offline?.payments.find((p) => p.qr === payerQr)

  async function tamper() {
    if (!shownPayment) return
    const target = setup.stores.find((s) => s.id === shownPayment.storeId)!
    const forged = tamperSignedPayment(shownPayment.signed)
    const qr = await encryptPaymentQr(forged, target.cert)
    const original = peek<PaymentBody>(shownPayment.signed.split('.')[2])!
    trace.emit({
      actor: 'payer',
      title: 'Alguien altera el QR del cliente',
      text: `Toma el pago firmado, cambia el monto a ${formatMoney(original.a * 2)} y lo vuelve a cifrar para la tienda (su llave de cifrado es pública). Lo que no puede hacer es volver a firmarlo: la llave privada está en el celular del cliente.`,
      crypto: ['Cifrado válido', 'Firma original: ya no coincide'],
      blocks: [{ title: 'Pago alterado', fields: paymentFields(peek<PaymentBody>(forged.split('.')[2])!, original) }],
      status: 'error',
    })
    setTamperedQr(qr)
    setTampered(true)
  }

  const hint = (
    <div className="hint" role="status" aria-live="polite">
      <span className="hint__dot" />
      <div>
        <span className="hint__label">Siguiente paso</span>
        <span>{nextHint(wallet, payerOnline, shownPayment?.status, storeQr?.startsWith('RECIBO.') ?? false)}</span>
      </div>
    </div>
  )

  const storePicker = (
    <div className="segmented" role="radiogroup" aria-label="Tienda que cobra">
      {setup.stores.map((s, i) => (
        <button key={s.id} type="button" role="radio" aria-checked={i === storeIdx} className={i === storeIdx ? 'is-active' : ''} onClick={() => setStoreIdx(i)}>
          {s.name}
        </button>
      ))}
    </div>
  )

  const tamperButton = (
    <button type="button" className="btn btn--ghost" disabled={!shownPayment || tampered} onClick={tamper}>
      Alterar QR del cliente
    </button>
  )

  return (
    <div className={`page page--demo ${inside ? 'page--inside' : ''}`}>
      {/* En escritorio es la columna lateral (o la barra superior en "Por dentro"); en pantallas angostas sus hijos se reordenan con la escena. */}
      <aside className="side">
        {inside ? (
          <div className="topbar">
            <button type="button" className="btn btn--ghost btn--icon topbar__back" onClick={() => setView('demo')}>
              <BackIcon size={16} /> Demo
            </button>
            <div className="topbar__brand">
              <span className="topbar__eyebrow">Bre-B · Por dentro</span>
              <strong>Pagos sin internet</strong>
            </div>
            {hint}
            <div className="topbar__actions">
              {storePicker}
              {tamperButton}
              <button type="button" className="btn btn--ghost" onClick={onReset}>Reiniciar</button>
            </div>
          </div>
        ) : (
          <>
            <Hero />
            <button type="button" className="btn btn--primary btn--icon inside-cta" onClick={() => setView('inside')}>
              <ShieldIcon size={18} /> Ver cómo funciona por dentro
            </button>
            {hint}
            <section className="controls" aria-label="Casos de prueba">
              <span className="control__label">Prueba casos</span>
              <div className="control__row">
                <span className="control__name">Tienda que cobra</span>
                {storePicker}
              </div>
              <div className="control__actions">
                {tamperButton}
                <button type="button" className="btn btn--ghost" onClick={onReset}>
                  Reiniciar
                </button>
              </div>
              <p className="control__help">
                Alterar intenta duplicar el monto sin la llave del cliente. También puedes escanear el mismo QR dos veces o
                cobrarlo en otra tienda.
              </p>
            </section>
            <footer className="footer">Proyecto conceptual personal, sin afiliación con Nu Holdings. Hecho por Juan David Ramírez.</footer>
          </>
        )}
      </aside>

      <main className="stage">
        <Phone key="payer" label="Cliente" variant="payer" online={payerOnline} onToggleOnline={() => setPayerOnline((v) => !v)}>
          <PayerApp
            server={setup.server}
            rootKey={setup.server.rootPublicKey}
            wallet={wallet}
            setWallet={setWallet}
            online={payerOnline}
            visibleStoreQr={storeQr}
            displayedQr={displayedQr}
            tampered={tampered}
            onShowQr={handlePayerQr}
          />
        </Phone>

        {inside && <InsidePanel key="inside" payerOnline={payerOnline} storeOnline={storeOnline} />}

        <Phone key="store" label="Tienda" variant="store" online={storeOnline} onToggleOnline={() => setStoreOnline((v) => !v)}>
          <StoreApp
            key={store.id}
            server={setup.server}
            rootKey={setup.server.rootPublicKey}
            store={store}
            local={storeLocals[store.id]}
            setLocal={setLocal}
            online={storeOnline}
            visiblePayerQr={displayedQr}
            onShowQr={setStoreQr}
          />
        </Phone>
      </main>
    </div>
  )
}

function nextHint(wallet: Wallet, payerOnline: boolean, shownStatus: string | undefined, receiptVisible: boolean): string {
  const off = wallet.offline
  if (shownStatus === 'pendiente' && receiptVisible) return 'La tienda aceptó. En el cliente, toca “Escanear comprobante”.'
  if (shownStatus === 'pendiente') return 'En la tienda, toca “Escanear pago del cliente”. Funciona aunque la tienda no tenga internet.'
  if (shownStatus === 'aceptado') return 'Pago aceptado por ambos lados. Se hace efectivo cuando cualquiera de los dos se conecte.'
  if (!off && wallet.history.length === 0) {
    return `Activa “Pagos sin internet” en el celular del cliente. Se reservan ${formatMoney(OFFLINE_LIMIT)} de su saldo.`
  }
  if (!off) return 'Conecta al cliente para renovar su cupo sin internet.'
  if (payerOnline && off.payments.length === 0) {
    return wallet.history.length === 0
      ? 'Ahora apaga el internet del cliente (y si quieres, el de la tienda) para simular el apagón.'
      : 'Cupo renovado con una llave nueva. Apaga el internet del cliente para volver a probar.'
  }
  if (off.payments.length === 0) return 'Toca “Pagar con QR” en el cliente y escanea el código de la tienda.'
  if (off.seq >= off.maxPayments) return 'Usaste los 3 pagos. Enciende el internet del cliente o de la tienda para liquidar.'
  return 'Haz otro pago o intenta pasarte del saldo. Enciende el internet de cualquiera de los dos para liquidar.'
}
