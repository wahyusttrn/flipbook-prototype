import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

export function QrCode({ value, size = 220, className = '' }: { value: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' }).then(setSrc)
  }, [value, size])
  return src ? (
    <img src={src} width={size} height={size} alt={`QR code for ${value}`} className={className} />
  ) : (
    <div style={{ width: size, height: size }} className={`bg-stone-100 ${className}`} />
  )
}
