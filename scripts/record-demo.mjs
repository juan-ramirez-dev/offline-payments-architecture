// Graba el flujo completo de la demo en video (MP4 + GIF), sin narrador.
// Uso: con `npm run dev` corriendo, ejecutar `npm run record` (demo) o `npm run record:inside`
// (vista "Por dentro", con el backend animado). Requiere Google Chrome instalado y ffmpeg en el PATH.

import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT_DIR = resolve(process.env.OUT_DIR ?? 'media')
const INSIDE = process.env.VIEW === 'inside'
const NAME = INSIDE ? 'pagos-sin-internet-por-dentro' : 'pagos-sin-internet'
const VIEWPORT = INSIDE ? { width: 1440, height: 900 } : { width: 1360, height: 860 }
const SCALE = 2
const SPEED = Number(process.env.SPEED ?? 1.25)

const RECORDING_CSS = `
  .hint { display: none !important; }
  .topbar .rec-caption { flex: 1; min-width: 320px; padding: 10px 14px; font-size: 15px; }
  .topbar .rec-caption__n { width: 28px; height: 28px; font-size: 13px; }
  .rec-caption {
    display: flex; align-items: center; gap: 14px;
    background: #17151c; color: #fff; border-radius: 16px; padding: 14px 18px;
    font-size: 17px; font-weight: 700; line-height: 1.3;
    box-shadow: 0 14px 30px -14px rgb(23 21 28 / 0.6);
    animation: rec-in 0.35s ease-out;
  }
  .rec-caption__n {
    flex: none; width: 32px; height: 32px; border-radius: 50%;
    background: #820ad1; display: grid; place-items: center; font-size: 15px;
  }
  @keyframes rec-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .rec-cursor {
    position: fixed; left: 0; top: 0; width: 28px; height: 28px; margin: -14px 0 0 -14px;
    border-radius: 50%; background: rgb(130 10 209 / 0.22); border: 2px solid #820ad1;
    z-index: 99999; pointer-events: none;
    transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .rec-cursor.tap::after {
    content: ''; position: absolute; inset: -2px; border-radius: 50%;
    border: 2px solid #820ad1; animation: rec-tap 0.45s ease-out;
  }
  @keyframes rec-tap { from { transform: scale(1); opacity: 1; } to { transform: scale(2.4); opacity: 0; } }
`

// Sin este flag, el screencast de Chrome headless entrega frames a 1x (ignora deviceScaleFactor)
// y el video sale borroso al reescalarlo.
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [`--force-device-scale-factor=${SCALE}`],
})
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
await page.goto(BASE_URL + (INSIDE ? '/#por-dentro' : '/'))
await page.locator('.device').nth(1).waitFor()
await page.evaluate(() => document.fonts.ready)
await page.addStyleTag({ content: RECORDING_CSS })
await page.evaluate(() => {
  const cursor = document.createElement('div')
  cursor.className = 'rec-cursor'
  cursor.style.transform = `translate(${innerWidth * 0.62}px, ${innerHeight + 40}px)`
  document.body.append(cursor)
})

const payer = page.locator('.device').nth(0)
const store = page.locator('.device').nth(1)
const wait = (ms) => page.waitForTimeout(ms)

async function caption(n, text) {
  await page.evaluate(
    ([n, text]) => {
      document.querySelector('.rec-caption')?.remove()
      const el = document.createElement('div')
      el.className = 'rec-caption'
      el.innerHTML = n ? `<span class="rec-caption__n">${n}</span><span></span>` : '<span></span>'
      el.lastElementChild.textContent = text
      const anchor = document.querySelector('.side .hero') ?? document.querySelector('.topbar__brand')
      anchor.after(el)
    },
    [n, text],
  )
}

async function click(locator) {
  await locator.waitFor({ state: 'visible' })
  const box = await locator.boundingBox()
  await page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.rec-cursor')
      c.classList.remove('tap')
      c.style.transform = `translate(${x}px, ${y}px)`
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  )
  await wait(560)
  await page.evaluate(() => {
    const c = document.querySelector('.rec-cursor')
    void c.offsetWidth
    c.classList.add('tap')
  })
  await locator.click()
  await wait(260)
}

const key = (k) => payer.getByRole('button', { name: k, exact: true })

// ---------- Grabación ----------

const framesDir = mkdtempSync(join(tmpdir(), 'demo-frames-'))
const frames = []
const cdp = await page.context().newCDPSession(page)
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = join(framesDir, `f${String(frames.length).padStart(5, '0')}.jpg`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  frames.push({ file, t: metadata.timestamp })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 98,
  maxWidth: VIEWPORT.width * SCALE,
  maxHeight: VIEWPORT.height * SCALE,
  everyNthFrame: 1,
})

const tab = (name) => page.getByRole('tab', { name })
/** Texto del subtítulo según la vista: [demo, por dentro]. */
const say = (n, demo, inside) => caption(n, INSIDE ? inside : demo)

await say(null, 'Pagos Bre-B sin internet, de punta a punta', 'Pagos Bre-B sin internet, por dentro')
await wait(INSIDE ? 2400 : 1600)

await say(1, 'Con internet, Juan reserva un cupo de $ 50.000 para pagar sin señal', 'El celular crea sus llaves y Nubank firma su cupo de $ 50.000')
await click(payer.getByRole('button', { name: 'Activar' }))
await payer.locator('.offline-card.is-active').waitFor()
await wait(INSIDE ? 2600 : 1200)

await say(2, 'Se va el internet en los dos celulares', 'Se va el internet: el backend queda fuera de alcance')
await click(payer.locator('.net-switch'))
await click(store.locator('.net-switch'))
await wait(700)

await say(3, 'Juan escanea el QR Bre-B de la tienda', 'El cliente verifica el certificado de la tienda con la llave raíz')
await click(payer.getByRole('button', { name: 'Pagar con QR' }))
await payer.locator('.amount').waitFor()
await wait(INSIDE ? 1600 : 500)

await say(4, 'Escribe el monto y su celular firma el pago', 'Firma el pago (ECDSA) y lo cifra solo para esa tienda (ECDH + AES-GCM)')
await click(key('1'))
await click(key('2'))
await click(key('000'))
await wait(400)
await click(payer.getByRole('button', { name: 'Generar código de pago' }))
await payer.locator('.pay-qr').waitFor()
await wait(900)
if (INSIDE) {
  await click(tab('Qué viaja'))
  await wait(2400)
}

await say(5, 'La tienda valida la firma sin internet', 'La tienda descifra y revisa la cadena de firmas, sin internet')
await click(store.getByRole('button', { name: /Escanear pago del cliente/ }))
await store.locator('.store-accepted').waitFor()
if (INSIDE) await click(page.locator('.step').nth(-2))
await wait(INSIDE ? 2400 : 1500)

await say(6, 'Juan escanea el comprobante: los dos tienen prueba del pago', 'La tienda firma un comprobante y el cliente lo verifica')
await click(payer.getByRole('button', { name: /Escanear comprobante/ }))
await payer.locator('.note--ok').waitFor()
await wait(INSIDE ? 2000 : 1600)

await say(7, 'Si alguien altera el monto, la firma no coincide', 'Un monto alterado rompe la firma del celular: rechazado')
await click(page.getByRole('button', { name: 'Alterar QR del cliente' }))
await wait(INSIDE ? 1800 : 500)
await click(store.getByRole('button', { name: 'Volver' }))
await click(store.getByRole('button', { name: /Escanear pago del cliente/ }))
await store.getByText('Pago rechazado').waitFor()
await wait(INSIDE ? 2600 : 1700)
await click(store.getByRole('button', { name: 'Volver' }))
await click(payer.getByRole('button', { name: 'Listo' }))
await wait(500)

await say(8, 'Vuelve el internet: el primero que se conecta liquida el pago', 'La tienda se conecta: Nubank verifica y liquida en el ledger')
await click(store.locator('.net-switch'))
await store.locator('.status--confirmado').waitFor()
await wait(INSIDE ? 2200 : 1000)
if (INSIDE) {
  await click(tab('Clojure'))
  await wait(2400)
  await say(9, '', 'El cliente sincroniza: se cierra el cupo y vuelve lo no usado')
}
await click(payer.locator('.net-switch'))
await payer.locator('.synced').waitFor()
if (INSIDE) {
  await wait(1400)
  await click(page.locator('.step').nth(-3))
}
await wait(INSIDE ? 2600 : 2200)

await say(null, 'Paga con Bre-B aunque no haya señal', 'Firmado en el celular, cifrado para la tienda, liquidado por Nubank')
await wait(2400)

await cdp.send('Page.stopScreencast')
await browser.close()

// ---------- Video ----------

mkdirSync(OUT_DIR, { recursive: true })
const list = frames
  .map((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 1
    return `file '${f.file}'\nduration ${Math.max(next - f.t, 0.001).toFixed(4)}`
  })
  .join('\n')
writeFileSync(join(framesDir, 'list.txt'), `${list}\nfile '${frames.at(-1).file}'\n`)

const mp4 = join(OUT_DIR, `${NAME}.mp4`)
const gif = join(OUT_DIR, `${NAME}.gif`)
const ffmpeg = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })

ffmpeg([
  '-f', 'concat', '-safe', '0', '-i', join(framesDir, 'list.txt'),
  '-vf', `setpts=PTS/${SPEED},fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'stillimage', '-movflags', '+faststart',
  mp4,
])
ffmpeg([
  '-i', mp4,
  '-vf', 'fps=15,scale=1440:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  '-loop', '0',
  gif,
])

rmSync(framesDir, { recursive: true, force: true })
console.log(`Listo:\n  ${mp4}\n  ${gif}`)
