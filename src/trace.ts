// Bitácora de lo que pasa por dentro. Los celulares y el servidor publican aquí cada paso
// con los datos reales que firmaron, cifraron o verificaron; la vista "Por dentro" la anima.

import type { CodeId } from './inside/snippets'

export type Actor = 'payer' | 'store' | 'server'
export type NodeId = 'payer' | 'store' | 'allowance' | 'kms' | 'ledger' | 'settlement'

export interface Field {
  k: string
  v: unknown
  note?: string
  bad?: boolean
}

export interface Block {
  title: string
  fields?: Field[]
  /** Partes del QR o del mensaje, con su tamaño en bytes. */
  parts?: { label: string; bytes: number; tone: 'head' | 'key' | 'sig' | 'data' | 'cipher' }[]
  text?: string
}

export interface Check {
  label: string
  /** `skip`: no se llegó a revisar porque falló un paso anterior. */
  state: 'ok' | 'fail' | 'skip' | 'wait'
  detail?: string
}

export interface LedgerLine {
  account: string
  amount: number
}

export interface TraceEvent {
  id: number
  at: number
  actor: Actor
  title: string
  text: string
  /** Ruta del paquete en el diagrama, salto por salto. */
  hops?: [NodeId, NodeId][]
  packet?: string
  crypto?: string[]
  blocks?: Block[]
  checks?: Check[]
  ledger?: LedgerLine[]
  code?: CodeId
  status: 'ok' | 'error' | 'info'
}

type Listener = (events: TraceEvent[]) => void

class Trace {
  private events: TraceEvent[] = []
  private listeners = new Set<Listener>()
  private nextId = 1

  emit(e: Omit<TraceEvent, 'id' | 'at' | 'status'> & { status?: TraceEvent['status'] }) {
    this.events = [...this.events, { status: 'ok', ...e, id: this.nextId++, at: Date.now() }]
    this.listeners.forEach((fn) => fn(this.events))
  }

  reset() {
    this.events = []
    this.listeners.forEach((fn) => fn(this.events))
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.events)
    return () => {
      this.listeners.delete(fn)
    }
  }
}

export const trace = new Trace()

/** Recorta firmas y llaves para mostrarlas: `MEUCIQ…x9Q` (64 B). */
export const short = (b64: string, n = 10) => (b64.length > n * 2 ? `${b64.slice(0, n)}…${b64.slice(-4)}` : b64)

/** Bytes que ocupa un texto base64url una vez decodificado. */
export const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4)
