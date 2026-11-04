// Código que se muestra en cada paso de la vista "Por dentro". Lo de los celulares es la
// lógica de esta demo (TypeScript + WebCrypto); lo del backend es una referencia en Clojure.

export type CodeId = 'clj-root' | 'clj-activate' | 'clj-settle' | 'clj-sync' | 'ts-keygen' | 'ts-pay' | 'ts-verify' | 'ts-receipt'

export interface Snippet {
  lang: 'clj' | 'ts'
  file: string
  code: string
}

export const snippets: Record<CodeId, Snippet> = {
  'clj-root': {
    lang: 'clj',
    file: 'nu/offline/stores.clj',
    code: `;; La llave raíz vive en un HSM (AWS KMS) y nunca sale de ahí:
;; el servicio solo puede pedirle firmas.
(defn register-store!
  [{:keys [conn kms]} {:keys [store-id llave sign-pk enc-pk]}]
  (let [cert {:id store-id :llave llave :pk sign-pk :ek enc-pk}]
    @(d/transact conn [{:store/id store-id :store/llave llave}])
    {:cert cert
     :sig  (kms/sign kms :offline-root (canonical-json cert))}))`,
  },
  'clj-activate': {
    lang: 'clj',
    file: 'nu/offline/allowance.clj',
    code: `(def limit 50000)
(def window-ms (* 48 60 60 1000))

(defn activate!
  "Reserva el cupo y firma el certificado del celular."
  [{:keys [conn kms]} {:keys [user-id device-id device-pk]}]
  (let [window-id (str "w-" (random-uuid))
        cert      {:u user-id :d device-id :w window-id :pk device-pk
                   :lim limit :max 3 :exp (+ (now-ms) window-ms)}]
    ;; Una sola transacción: si el saldo no alcanza, no se crea el cupo.
    @(d/transact conn [[:ledger/transfer [:account/user user-id]
                                         [:reserve/window window-id] limit]
                       {:window/id window-id :window/user user-id
                        :window/device device-id :window/status :open}])
    {:cert cert
     :sig  (kms/sign kms :offline-root (canonical-json cert))}))`,
  },
  'clj-settle': {
    lang: 'clj',
    file: 'nu/offline/settlement.clj',
    code: `(defn settle-store-upload!
  [{:keys [conn root-pk producer]} store-id {:keys [payment receipt]}]
  ;; La misma cadena que revisó la tienda (java.security, ECDSA P-256).
  (let [{:keys [cert body] :as p} (crypto/verify-payment root-pk payment)
        rcpt                       (crypto/verify-receipt root-pk receipt)]
    (cond
      (nil? p)                                   (reject :firma)
      (not (receipt-matches? rcpt p store-id))   (reject :tienda-no-autenticada)
      :else
      (let [win  (d/entity (d/db conn) [:window/id (:w cert)])
            prev (settled win (:s body))]
        (cond
          (= prev (select-keys body [:st :a]))   {:status :confirmado} ; idempotente
          prev                                   (reject :doble-gasto)
          (and (closed? win) (not (held? win (:s body))))
          (reject :no-reportado)
          :else
          ;; :window/settle revisa el cupo dentro de la transacción.
          (do @(d/transact conn [[:window/settle (:w cert) (:s body) store-id (:a body)]])
              (kafka/send! producer :offline-payment-settled
                           {:window (:w cert) :seq (:s body) :store store-id})
              {:status :confirmado}))))))`,
  },
  'clj-sync': {
    lang: 'clj',
    file: 'nu/offline/settlement.clj',
    code: `(defn sync-payer!
  "Con comprobante se liquida ya; sin comprobante queda reservado."
  [{:keys [conn root-pk] :as ctx} user-id window-id uploads]
  (let [statuses
        (into {}
              (keep (fn [{:keys [payment receipt]}]
                      (when-let [{:keys [cert body] :as p} (crypto/verify-payment root-pk payment)]
                        (when (and (= window-id (:w cert)) (= user-id (:u cert)))
                          [(:s body)
                           (if (receipt-matches? (crypto/verify-receipt root-pk receipt) p (:st body))
                             (settle! ctx p)
                             (hold! ctx p))]))))
              uploads)]
    ;; Cerrar y devolver lo no usado va en la misma transacción.
    @(d/transact conn [[:window/close window-id]])
    {:statuses statuses
     :refund   (window-refund (d/db conn) window-id)}))`,
  },
  'ts-keygen': {
    lang: 'ts',
    file: 'app del cliente · activar cupo',
    code: `// En el celular. La privada no se puede exportar.
const keys = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
)
const pk = await crypto.subtle.exportKey('raw', keys.publicKey)

// Por TLS: Nubank responde con el certificado del cupo.
const { cert, certEnv } = await api.activateOffline({ userId, deviceId, pk })`,
  },
  'ts-pay': {
    lang: 'ts',
    file: 'app del cliente · firmar y cifrar',
    code: `const body = { st: store.id, a, b0, b1: b0 - a, s: seq + 1, ts: Date.now(), n: nonce() }
const signed = \`\${certEnv}.\${await seal(body, deviceKey)}\`   // ECDSA

// Cifrado solo para esta tienda (ECIES).
const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: storeEk }, eph.privateKey, 256)
const aes = await hkdf(secret, { salt: epk, info: 'pagos-sin-internet/v1' })  // AES-256
const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: epk }, aes, utf8(signed))

const qr = 'PAGO.' + b64url(epk + iv + ct)`,
  },
  'ts-verify': {
    lang: 'ts',
    file: 'app de la tienda · validar',
    code: `// En la tienda, sin internet.
const signed = await decryptPaymentQr(qr, store.decryptKey)  // solo esta tienda puede
const [cert, certSig, body, bodySig] = signed.split('.')

verify(ROOT_PUBLIC_KEY, certSig, cert)   // Nubank firmó el certificado
verify(cert.pk, bodySig, body)           // ese celular firmó el pago

body.st === store.id                     // va para mí
now <= cert.exp && body.s <= cert.max    // reglas del cupo
body.b1 === body.b0 - body.a             // el saldo cuadra
!seen.has(\`\${cert.w}:\${body.s}\`)        // no lo cobré antes`,
  },
  'ts-receipt': {
    lang: 'ts',
    file: 'app de la tienda · comprobante',
    code: `const receipt = await encodeReceiptQr(
  store.certEnv,
  { w: cert.w, s: body.s, st: store.id, a: body.a, ts: Date.now() },
  store.signingKey,                      // firma de la tienda
)
local.sales.push({ payment: signed, receipt, status: 'por-liquidar' })
if (online) upload([sale])               // si no, apenas vuelva el internet`,
  },
}

type Tok = { t: string; c?: 'com' | 'str' | 'kw' | 'key' | 'num' }

const RULES: Record<Snippet['lang'], RegExp> = {
  clj: /(;[^\n]*)|("(?:[^"\\]|\\.)*")|(:[\w\-/.?!*]+)|(?<=\()(defn|def|let|if|cond|when|when-let|do|fn|ns|into|keep|and|not|nil\?|=)(?=[\s)])|(\b\d[\d_]*\b)/g,
  ts: /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b[a-z]\w*(?=:\s))|\b(const|await|async|function|return|if|new|false|true)\b|(\b\d+\b)/g,
}

/** Resaltado mínimo: comentarios, textos, palabras clave y números. */
export function highlight(code: string, lang: Snippet['lang']): Tok[] {
  const out: Tok[] = []
  let last = 0
  for (const m of code.matchAll(RULES[lang])) {
    if (m.index! > last) out.push({ t: code.slice(last, m.index) })
    const c = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'key' : m[4] ? 'kw' : 'num'
    out.push({ t: m[0], c })
    last = m.index! + m[0].length
  }
  if (last < code.length) out.push({ t: code.slice(last) })
  return out
}
