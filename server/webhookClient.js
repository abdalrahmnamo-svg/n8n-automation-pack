/**
 * Minimal webhook sender. Every request carries the shared-secret header and an
 * Idempotency-Key so the receiving side can suppress duplicates.
 *
 * Result shape: { sent, status?, retryable?, reason? }
 *   - network errors and 5xx/429 are retryable
 *   - other 4xx (bad secret, bad payload) are NOT retryable
 */
export const SECRET_HEADER = 'x-webhook-secret'

export function createWebhookSender({ url, secret, fetchImpl = fetch }) {
  if (!url) throw new Error('webhook url is required')
  return async function send(payload, { idempotencyKey } = {}) {
    const headers = { 'content-type': 'application/json', [SECRET_HEADER]: secret }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload) })
      if (res.ok) return { sent: true, status: res.status }
      const retryable = res.status >= 500 || res.status === 429
      return { sent: false, status: res.status, retryable, reason: `HTTP ${res.status}` }
    } catch (err) {
      return { sent: false, retryable: true, reason: `unreachable: ${err?.message || err}` }
    }
  }
}
