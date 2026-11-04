import { DeleteIcon } from './icons'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', 'del'] as const

/** Teclado de monto en pesos: cada dígito desplaza a la izquierda; "000" agrega tres ceros. */
export function Keypad({ value, onChange, max = 9_999_999 }: { value: number; onChange: (v: number) => void; max?: number }) {
  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'del') return onChange(Math.floor(value / 10))
    const next = value * 10 ** k.length + Number(k)
    if (next <= max) onChange(next)
  }

  return (
    <div className="keypad">
      {KEYS.map((k) => (
        <button key={k} type="button" className="keypad__key" onClick={() => press(k)} aria-label={k === 'del' ? 'Borrar' : k}>
          {k === 'del' ? <DeleteIcon /> : k}
        </button>
      ))}
    </div>
  )
}
