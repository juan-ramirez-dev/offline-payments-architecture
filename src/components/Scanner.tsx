import { useEffect, useRef } from 'react'
import { BackIcon } from './icons'

interface Props {
  hint: string
  onDone: () => void
  onCancel: () => void
}

/** Visor de cámara simulado: "lee" lo que el otro celular tenga en pantalla. */
export function Scanner({ hint, onDone, onCancel }: Props) {
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    const t = setTimeout(() => done.current(), 1500)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="scanner">
      <button type="button" className="icon-btn icon-btn--light scanner__back" onClick={onCancel} aria-label="Cancelar">
        <BackIcon />
      </button>
      <div className="scanner__frame">
        <span className="scanner__corner tl" />
        <span className="scanner__corner tr" />
        <span className="scanner__corner bl" />
        <span className="scanner__corner br" />
        <span className="scanner__line" />
      </div>
      <p className="scanner__hint">{hint}</p>
    </div>
  )
}
