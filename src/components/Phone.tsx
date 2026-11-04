import { useEffect, useState } from 'react'
import { WifiIcon, WifiOffIcon } from './icons'

interface Props {
  label: string
  online: boolean
  onToggleOnline: () => void
  variant: 'payer' | 'store'
  children: React.ReactNode
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  return now.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function Phone({ label, online, onToggleOnline, variant, children }: Props) {
  const time = useClock()
  return (
    <figure className="device">
      <figcaption className="device__caption">
        <span className="device__label">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={online}
          className={`net-switch ${online ? 'is-on' : 'is-off'}`}
          onClick={onToggleOnline}
        >
          {online ? <WifiIcon /> : <WifiOffIcon />}
          <span>{online ? 'Con internet' : 'Sin internet'}</span>
          <span className="net-switch__track"><span className="net-switch__thumb" /></span>
        </button>
      </figcaption>

      <div className={`phone phone--${variant}`}>
        <div className="phone__screen">
          <div className="statusbar">
            <span>{time}</span>
            <span className="statusbar__notch" />
            <span className={`statusbar__net ${online ? '' : 'is-off'}`}>
              {online ? <WifiIcon size={13} /> : <WifiOffIcon size={13} />}
            </span>
          </div>
          {!online && <div className="offline-strip">Sin conexión</div>}
          <div className="phone__content">{children}</div>
        </div>
      </div>
    </figure>
  )
}
