import { useEffect, useRef, useState } from 'react'
import { trace, type Actor, type Block, type NodeId, type TraceEvent } from '../trace'
import { highlight, snippets } from './snippets'
import { money } from './describe'
import { CheckIcon, ClockIcon, XIcon } from '../components/icons'

// ---------- Diagrama ----------

type Pt = [number, number]

const NODE_W = 140
const NODE_H = 46

const NODES: Record<Exclude<NodeId, 'payer' | 'store'>, { x: number; y: number; title: string; sub: string }> = {
  allowance: { x: 96, y: 34, title: 'Cupos sin internet', sub: 'servicio en Clojure' },
  kms: { x: 324, y: 34, title: 'KMS · llave raíz', sub: 'HSM: solo firma' },
  settlement: { x: 96, y: 130, title: 'Liquidación', sub: 'Clojure + Kafka' },
  ledger: { x: 324, y: 130, title: 'Ledger', sub: 'Datomic · doble partida' },
}

/** Rutas en coordenadas del viewBox. La inversa se obtiene invirtiendo los puntos. */
const ROUTES: Record<string, Pt[]> = {
  'payer>allowance': [[26, 105], [132, 105], [132, 80]],
  'payer>settlement': [[26, 105], [132, 105], [132, 130]],
  'store>settlement': [[534, 105], [200, 105], [200, 130]],
  'allowance>kms': [[236, 57], [324, 57]],
  'allowance>ledger': [[236, 72], [300, 72], [300, 142], [324, 142]],
  'settlement>ledger': [[236, 153], [324, 153]],
  'settlement>allowance': [[166, 130], [166, 80]],
  'kms>store': [[464, 57], [480, 57], [480, 105], [534, 105]],
  'payer>store': [[26, 232], [534, 232]],
}

function route(a: NodeId, b: NodeId): Pt[] | null {
  return ROUTES[`${a}>${b}`] ?? ROUTES[`${b}>${a}`]?.slice().reverse() ?? null
}

const toPath = (pts: Pt[]) => 'M' + pts.map((p) => p.join(' ')).join(' L')
const segLen = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])
const polyLen = (pts: Pt[]) => pts.slice(1).reduce((t, p, i) => t + segLen(pts[i], p), 0)

function pointAt(pts: Pt[], d: number): Pt {
  for (let i = 1; i < pts.length; i++) {
    const l = segLen(pts[i - 1], pts[i])
    if (d <= l) {
      const k = l ? d / l : 0
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]
    }
    d -= l
  }
  return pts[pts.length - 1]
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

interface Flight {
  id: number
  actor: Actor
  label?: string
  hops: Pt[][]
}

/** Paquete que recorre su ruta salto por salto. */
function Packet({ flight, onDone }: { flight: Flight; onDone: (id: number) => void }) {
  const ref = useRef<SVGGElement>(null)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    const lens = flight.hops.map(polyLen)
    const durs = lens.map((l) => Math.max(420, l / 0.4))
    const GAP = 160
    let start: number | null = null
    let raf = 0
    const tick = (t: number) => {
      start ??= t
      let el = t - start
      let i = 0
      while (i < durs.length && el > durs[i] + GAP) el -= durs[i++] + GAP
      const g = ref.current
      if (i >= durs.length || !g) return done.current(flight.id)
      if (el > durs[i]) g.style.opacity = '0'
      else {
        const [x, y] = pointAt(flight.hops[i], lens[i] * ease(el / durs[i]))
        g.style.opacity = '1'
        g.setAttribute('transform', `translate(${x} ${y})`)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [flight])

  return (
    <>
      {flight.hops.map((h, i) => (
        <path key={i} d={toPath(h)} className={`route route--live route--${flight.actor}`} />
      ))}
      <g ref={ref} className={`packet packet--${flight.actor}`} style={{ opacity: 0 }}>
        <circle r="7" />
        {flight.label && (
          <text y="-13" textAnchor="middle">
            {flight.label}
          </text>
        )}
      </g>
    </>
  )
}

function Diagram({ current, flights, payerOnline, storeOnline, onFlightDone }: {
  current?: TraceEvent
  flights: Flight[]
  payerOnline: boolean
  storeOnline: boolean
  onFlightDone: (id: number) => void
}) {
  const active = new Set<NodeId>(current?.hops?.flat() ?? [])
  if (current) active.add(current.actor === 'server' ? 'settlement' : current.actor)
  if (current?.actor === 'server' && !current.hops?.length) active.delete('settlement')

  return (
    <svg className="diagram" viewBox="0 0 560 256" role="img" aria-label="Arquitectura: cliente, tienda y servicios de Nubank">
      <rect className="cloud" x="64" y="6" width="432" height="186" rx="18" />
      <text className="cloud__label" x="280" y="24" textAnchor="middle">Nubank · con internet</text>

      {Object.values(ROUTES).map((pts, i) => (
        <path key={i} d={toPath(pts)} className="route" />
      ))}

      <text className="lane__label" x="280" y="250" textAnchor="middle">QR en pantalla · funciona sin internet</text>

      {(Object.keys(NODES) as (keyof typeof NODES)[]).map((k) => {
        const n = NODES[k]
        return (
          <g key={k} className={`node ${active.has(k) ? 'is-active' : ''}`} transform={`translate(${n.x} ${n.y})`}>
            <rect width={NODE_W} height={NODE_H} rx="12" />
            <text className="node__title" x={NODE_W / 2} y="20" textAnchor="middle">{n.title}</text>
            <text className="node__sub" x={NODE_W / 2} y="35" textAnchor="middle">{n.sub}</text>
          </g>
        )
      })}

      <g className={`device-bar device-bar--payer ${active.has('payer') ? 'is-active' : ''}`}>
        <rect x="0" y="70" width="26" height="180" rx="8" />
        <text transform="translate(17 160) rotate(-90)" textAnchor="middle">CLIENTE</text>
      </g>
      <g className={`device-bar device-bar--store ${active.has('store') ? 'is-active' : ''}`}>
        <rect x="534" y="70" width="26" height="180" rx="8" />
        <text transform="translate(543 160) rotate(90)" textAnchor="middle">TIENDA</text>
      </g>

      {!payerOnline && <Cut x={45} />}
      {!storeOnline && <Cut x={515} />}

      {flights.map((f) => (
        <Packet key={f.id} flight={f} onDone={onFlightDone} />
      ))}
    </svg>
  )
}

function Cut({ x }: { x: number }) {
  return (
    <g className="cut">
      <line x1={x - 17} y1="105" x2={x + 17} y2="105" />
      <circle cx={x} cy="105" r="9" />
      <path d={`M${x - 3.5} 101.5 l7 7 M${x + 3.5} 101.5 l-7 7`} />
      <text x={x} y="126" textAnchor="middle">sin señal</text>
    </g>
  )
}

// ---------- Detalle ----------

const actorLabel: Record<Actor, string> = { payer: 'Celular del cliente', store: 'Celular de la tienda', server: 'Backend de Nubank' }

type Tab = 'checks' | 'data' | 'code'

function BlockView({ b }: { b: Block }) {
  const total = b.parts?.reduce((t, p) => t + p.bytes, 0) ?? 0
  return (
    <section className="blk">
      <span className="blk__title">{b.title}</span>
      {b.parts && b.parts.length > 0 && (
        <>
          <div className="bytes" aria-hidden="true">
            {b.parts.map((p, i) => (
              <span key={i} className={`bytes__seg bytes__seg--${p.tone}`} style={{ flexGrow: Math.max(p.bytes, total * 0.04) }} />
            ))}
          </div>
          <ul className="bytes__legend">
            {b.parts.map((p, i) => (
              <li key={i}><span className={`bytes__dot bytes__seg--${p.tone}`} />{p.label} <span className="muted">{p.bytes} B</span></li>
            ))}
          </ul>
        </>
      )}
      {b.fields && (
        <dl className="fields">
          {b.fields.map((f) => (
            <div key={f.k} className={f.bad ? 'is-bad' : ''}>
              <dt>{f.k}</dt>
              <dd className="fields__v">{typeof f.v === 'string' ? `"${f.v}"` : String(f.v)}</dd>
              <dd className="fields__note">{f.note}</dd>
            </div>
          ))}
        </dl>
      )}
      {b.text && <p className="blk__text">{b.text}</p>}
    </section>
  )
}

function Detail({ e, n }: { e: TraceEvent; n: number }) {
  const tabs: { id: Tab; label: string }[] = []
  if (e.checks?.length || e.ledger?.length) tabs.push({ id: 'checks', label: e.checks?.length ? 'Verificación' : 'Ledger' })
  if (e.blocks?.length) tabs.push({ id: 'data', label: 'Qué viaja' })
  if (e.code) tabs.push({ id: 'code', label: snippets[e.code].lang === 'clj' ? 'Clojure' : 'Código' })
  const [tab, setTab] = useState<Tab | undefined>(tabs[0]?.id)
  const shown = tabs.find((t) => t.id === tab) ? tab : tabs[0]?.id
  const snip = e.code && snippets[e.code]

  return (
    <article className={`detail detail--${e.actor} ${e.status === 'error' ? 'is-error' : ''}`}>
      <div className="detail__head">
        <span className={`who who--${e.actor}`}>{actorLabel[e.actor]}</span>
        <span className="detail__n">Paso {n}</span>
      </div>
      <h2 className="detail__title">{e.title}</h2>
      <p className="detail__text">{e.text}</p>
      {e.crypto && (
        <div className="detail__chips">
          {e.crypto.map((c) => <span key={c} className="cchip">{c}</span>)}
        </div>
      )}

      {tabs.length > 1 && (
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={shown === t.id} className={shown === t.id ? 'is-active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="detail__body">
        {shown === 'checks' && (
          <>
            {e.checks && (
              <ol className="checks">
                {e.checks.map((c, i) => (
                  <li key={i} className={`check check--${c.state}`} style={{ animationDelay: `${i * 110}ms` }}>
                    <span className="check__icon">
                      {c.state === 'ok' ? <CheckIcon size={12} /> : c.state === 'fail' ? <XIcon size={12} /> : c.state === 'wait' ? <ClockIcon size={12} /> : null}
                    </span>
                    <span>
                      {c.label}
                      {c.detail && <span className="check__detail">{c.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {e.ledger && e.ledger.length > 0 && (
              <section className="blk">
                <span className="blk__title">Asientos en el ledger</span>
                <table className="ledger">
                  <tbody>
                    {e.ledger.map((l, i) => (
                      <tr key={i} style={{ animationDelay: `${i * 90}ms` }}>
                        <td>{l.account}</td>
                        <td className={l.amount < 0 ? 'is-debit' : 'is-credit'}>{l.amount < 0 ? '−' : '+'}{money(Math.abs(l.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td>Suma (siempre cero)</td><td>{money(e.ledger.reduce((t, l) => t + l.amount, 0))}</td></tr>
                  </tfoot>
                </table>
              </section>
            )}
          </>
        )}
        {shown === 'data' && e.blocks?.map((b, i) => <BlockView key={i} b={b} />)}
        {shown === 'code' && snip && (
          <figure className="code">
            <figcaption>
              <span className={`code__lang code__lang--${snip.lang}`}>{snip.lang === 'clj' ? 'Clojure · referencia del backend' : 'TypeScript · esta demo'}</span>
              <span className="muted">{snip.file}</span>
            </figcaption>
            <pre>
              {highlight(snip.code, snip.lang).map((t, i) => (t.c ? <span key={i} className={`tk-${t.c}`}>{t.t}</span> : t.t))}
            </pre>
          </figure>
        )}
      </div>
    </article>
  )
}

// ---------- Panel ----------

export function InsidePanel({ payerOnline, storeOnline }: { payerOnline: boolean; storeOnline: boolean }) {
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [flights, setFlights] = useState<Flight[]>([])
  const lastSeen = useRef(0)
  const net = useRef({ payerOnline, storeOnline })
  net.current = { payerOnline, storeOnline }
  const stepsRef = useRef<HTMLOListElement>(null)

  useEffect(
    () =>
      trace.subscribe((all) => {
        setEvents(all)
        const fresh = all.filter((e) => e.id > lastSeen.current)
        lastSeen.current = all.at(-1)?.id ?? 0
        if (fresh.length === 0) return
        setSelected(null)
        const { payerOnline, storeOnline } = net.current
        // Lo que va hacia un celular sin internet no llega: el salto se omite.
        const reachable = ([a, b]: [NodeId, NodeId]) =>
          (a === 'payer' && b === 'store') || (a === 'store' && b === 'payer') ||
          (![a, b].includes('payer') || payerOnline) && (![a, b].includes('store') || storeOnline)
        const next = fresh.flatMap((e): Flight[] => {
          const hops = (e.hops ?? []).filter(reachable).map(([a, b]) => route(a, b)).filter((r): r is Pt[] => !!r)
          return hops.length ? [{ id: e.id, actor: e.actor, label: e.packet, hops }] : []
        })
        if (next.length) setFlights((f) => [...f, ...next])
      }),
    [],
  )

  useEffect(() => {
    stepsRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest', inline: 'end' })
  }, [events.length])

  const currentIdx = selected ? events.findIndex((e) => e.id === selected) : events.length - 1
  const current = events[currentIdx]

  return (
    <section className="inside" aria-label="Cómo funciona por dentro">
      <header className="inside__top">
        <span className="inside__title">Por dentro</span>
        <span className="legend">
          <span className="legend__i legend__i--payer">Cliente</span>
          <span className="legend__i legend__i--store">Tienda</span>
          <span className="legend__i legend__i--server">Nubank</span>
        </span>
      </header>

      <Diagram
        current={current}
        flights={flights}
        payerOnline={payerOnline}
        storeOnline={storeOnline}
        onFlightDone={(id) => setFlights((f) => f.filter((x) => x.id !== id))}
      />

      <ol className="steps" ref={stepsRef} aria-label="Pasos">
        {events.map((e, i) => (
          <li key={e.id}>
            <button
              type="button"
              className={`step step--${e.actor} ${e.status === 'error' ? 'is-error' : ''} ${i === currentIdx ? 'is-current' : ''}`}
              onClick={() => setSelected(i === events.length - 1 ? null : e.id)}
              title={e.title}
            >
              {i + 1}
            </button>
          </li>
        ))}
      </ol>

      {current && <Detail key={current.id} e={current} n={currentIdx + 1} />}
    </section>
  )
}
