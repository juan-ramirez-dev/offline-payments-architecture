import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** QR con el sello Bre-B al centro. El nivel M tolera el sello sin dejar de ser legible. */
export function QrImage({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const [src, setSrc] = useState<string>()

  useEffect(() => {
    let alive = true
    QRCode.toDataURL(text, { margin: 2, width: size * 3, errorCorrectionLevel: 'M', color: { dark: '#111014', light: '#ffffff' } })
      .then((url) => alive && setSrc(url))
    return () => {
      alive = false
    }
  }, [text, size])

  return (
    <div className="qr" style={{ width: size, height: size }}>
      {src && <img src={src} width={size} height={size} alt={label} />}
      <span className="qr__seal" style={{ fontSize: Math.max(9, Math.round(size * 0.065)) }} aria-hidden="true">
        Bre-B
      </span>
    </div>
  )
}
