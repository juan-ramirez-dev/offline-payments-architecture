// Traduce los mensajes del protocolo a campos legibles para la vista "Por dentro".

import { formatMoney, paymentQrParts, type DeviceCert, type PaymentBody, type ReceiptBody, type StoreCert } from '../protocol'
import { b64Bytes, short, type Block, type Field } from '../trace'

export const money = formatMoney

const when = (ts: number) =>
  new Date(ts).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export function deviceCertFields(c: DeviceCert): Field[] {
  return [
    { k: 'u', v: c.u, note: 'cliente' },
    { k: 'd', v: c.d, note: 'id del celular' },
    { k: 'w', v: c.w, note: 'id del cupo' },
    { k: 'pk', v: short(c.pk), note: 'llave pública del celular' },
    { k: 'lim', v: c.lim, note: `cupo: ${money(c.lim)}` },
    { k: 'max', v: c.max, note: 'pagos permitidos' },
    { k: 'exp', v: c.exp, note: `vence ${when(c.exp)}` },
  ]
}

export function storeCertFields(c: StoreCert): Field[] {
  return [
    { k: 'id', v: c.id, note: 'comercio' },
    { k: 'llave', v: c.llave, note: 'llave Bre-B' },
    { k: 'pk', v: short(c.pk), note: 'firma sus comprobantes' },
    { k: 'ek', v: short(c.ek), note: 'los pagos se cifran para ella' },
  ]
}

/** `original` marca en rojo lo que no coincide con lo que firmó el celular. */
export function paymentFields(b: PaymentBody, original?: PaymentBody): Field[] {
  const bad = (k: keyof PaymentBody) => !!original && original[k] !== b[k]
  return [
    { k: 'st', v: b.st, note: 'tienda a la que va el pago' },
    { k: 'a', v: b.a, note: bad('a') ? `alterado: el celular firmó ${money(original!.a)}` : `monto: ${money(b.a)}`, bad: bad('a') },
    { k: 'b0', v: b.b0, note: 'saldo sin internet antes' },
    { k: 'b1', v: b.b1, note: 'saldo después (b0 − a)' },
    { k: 's', v: b.s, note: 'número de pago en el cupo' },
    { k: 'ts', v: b.ts, note: when(b.ts) },
    { k: 'n', v: b.n, note: 'nonce aleatorio' },
  ]
}

export function receiptFields(b: ReceiptBody): Field[] {
  return [
    { k: 'w', v: b.w, note: 'cupo del cliente' },
    { k: 's', v: b.s, note: 'número de pago' },
    { k: 'st', v: b.st, note: 'tienda' },
    { k: 'a', v: b.a, note: money(b.a) },
    { k: 'ts', v: b.ts, note: when(b.ts) },
  ]
}

/** Anatomía del QR cifrado que ve la cámara de la tienda. */
export function paymentQrBlock(qr: string): Block {
  const p = paymentQrParts(qr)
  return {
    title: `Lo que ve la cámara · ${qr.length} caracteres`,
    parts: p
      ? [
          { label: 'PAGO.', bytes: 5, tone: 'head' },
          { label: 'llave efímera', bytes: p.epk.length, tone: 'key' },
          { label: 'iv', bytes: p.iv.length, tone: 'key' },
          { label: 'pago firmado, cifrado', bytes: p.ct.length - 16, tone: 'cipher' },
          { label: 'etiqueta GCM', bytes: 16, tone: 'sig' },
        ]
      : [],
    text: 'Sin la llave privada de la tienda esto es ruido: no se ve ni el monto ni quién paga.',
  }
}

/** Anatomía del pago firmado (lo que queda tras descifrar). */
export function signedPaymentBlock(signed: string): Block {
  const [cert, certSig, body, bodySig] = signed.split('.')
  return {
    title: 'Pago firmado',
    parts: [
      { label: 'certificado', bytes: b64Bytes(cert), tone: 'data' },
      { label: 'firma Nubank', bytes: b64Bytes(certSig), tone: 'sig' },
      { label: 'pago', bytes: b64Bytes(body), tone: 'data' },
      { label: 'firma celular', bytes: b64Bytes(bodySig), tone: 'sig' },
    ],
  }
}
