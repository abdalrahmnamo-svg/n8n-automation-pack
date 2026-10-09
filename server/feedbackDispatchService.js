/**
 * Dispatch outbox: durable send state for feedback emails, with idempotency,
 * retry/backoff and duplicate suppression.
 *
 *   held    -> parked by "send later"; only a manual send/flush moves it
 *   queued  -> a flush (scheduledFor <= now) or a manual send will deliver it
 *   sending -> an attempt is in flight
 *   sent    -> delivered (never re-sent unless force=true)
 *   failed  -> all attempts exhausted, resendable
 *
 * Storage and transport are injected, so the logic is testable with no network and no DB:
 *   store: { get(id), put(row), list(predicate) }   (see createMemoryStore)
 *   send:  async (payload, { idempotencyKey }) => { sent, retryable?, reason? }
 */

export const FLUSHABLE_STATUSES = ['held', 'queued', 'failed']

export function idempotencyKeyFor(conversationId, kind = 'feedback') {
  return `${kind}:${conversationId}`
}

export function createMemoryStore() {
  const rows = new Map()
  return {
    async get(conversationId) {
      const r = rows.get(conversationId)
      return r ? { ...r } : null
    },
    async put(row) {
      rows.set(row.conversationId, { ...row })
      return { ...row }
    },
    async list(predicate = () => true) {
      return [...rows.values()].filter(predicate).map((r) => ({ ...r }))
    },
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createDispatchService({
  store,
  send,
  hasScore = async () => true,
  loadPayload = async () => null,
  maxAttempts = 3,
  baseDelayMs = 200,
  sleep = defaultSleep,
  now = () => new Date(),
}) {
  // One in-flight promise per conversation: concurrent callers share a single send.
  const inFlight = new Map()

  async function upsertDispatch({ conversationId, payload, sendLater, scheduledFor, approvedBy }) {
    const existing = await store.get(conversationId)
    const status = sendLater ? (scheduledFor ? 'queued' : 'held') : 'queued'
    return store.put({
      attempts: 0,
      ...existing,
      conversationId,
      payload,
      status,
      scheduledFor: scheduledFor ?? null,
      approvedBy: approvedBy ?? null,
      lastError: null,
    })
  }

  async function attemptWithRetry(row) {
    let result = { sent: false, reason: 'not attempted' }
    let attempts = row.attempts || 0
    for (let i = 0; i < maxAttempts; i += 1) {
      result = await send(row.payload, { idempotencyKey: idempotencyKeyFor(row.conversationId) })
      attempts += 1
      if (result.sent || result.retryable === false) break
      if (i < maxAttempts - 1) await sleep(baseDelayMs * 2 ** i)
    }
    return { result, attempts }
  }

  async function doSend(conversationId, force) {
    let row = await store.get(conversationId)
    if (row?.status === 'sent' && !force) {
      return { dispatch: row, result: { sent: false, reason: 'already_sent', code: 'already_sent' } }
    }
    if (!row) {
      const payload = await loadPayload(conversationId)
      if (!payload) {
        return { dispatch: null, result: { sent: false, reason: 'no approved score for conversation' } }
      }
      row = await store.put({ conversationId, payload, status: 'queued', attempts: 0, lastError: null })
    }
    await store.put({ ...row, status: 'sending' })
    const { result, attempts } = await attemptWithRetry(row)
    const stamp = now()
    const dispatch = await store.put(
      result.sent
        ? { ...row, status: 'sent', sentAt: stamp, lastAttemptAt: stamp, lastError: null, attempts }
        : {
            ...row,
            status: 'failed',
            lastAttemptAt: stamp,
            lastError: result.reason || 'unreachable',
            attempts,
          },
    )
    return { dispatch, result }
  }

  /** Send one dispatch now. Same conversation twice => one send (dedupe by key). */
  function sendDispatchNow(conversationId, { force = false } = {}) {
    const running = inFlight.get(conversationId)
    if (running) return running
    const p = doSend(conversationId, force).finally(() => inFlight.delete(conversationId))
    inFlight.set(conversationId, p)
    return p
  }

  /** Record that a manual send already happened elsewhere. Requires a score. */
  async function recordManualDispatchSent({ conversationId, payload, approvedBy }) {
    if (!(await hasScore(conversationId))) {
      return { ok: false, reason: 'no score for conversation', code: 'no_score' }
    }
    const existing = await store.get(conversationId)
    if (existing?.status === 'sent') return { ok: true, alreadySent: true, dispatch: existing }
    const snap = payload && typeof payload === 'object' ? payload : await loadPayload(conversationId)
    if (!snap) return { ok: false, reason: 'could not build payload', code: 'no_payload' }
    const stamp = now()
    const dispatch = await store.put({
      ...existing,
      conversationId,
      payload: snap,
      status: 'sent',
      sentAt: stamp,
      lastAttemptAt: stamp,
      lastError: null,
      approvedBy: approvedBy ?? existing?.approvedBy ?? null,
      attempts: (existing?.attempts || 0) + 1,
    })
    return { ok: true, alreadySent: false, dispatch }
  }

  const getDispatch = (conversationId) => store.get(conversationId)

  async function flushDispatches({ onlyDue = false } = {}) {
    const t = now()
    const rows = await store.list(
      (r) =>
        FLUSHABLE_STATUSES.includes(r.status) &&
        (!onlyDue || !r.scheduledFor || new Date(r.scheduledFor) <= t),
    )
    let sent = 0
    const failures = []
    for (const { conversationId } of rows) {
      const { result } = await sendDispatchNow(conversationId)
      if (result.sent) sent += 1
      else failures.push({ conversationId, reason: result.reason })
    }
    return { total: rows.length, sent, failed: failures.length, failures }
  }

  /** Worker entry: only queued rows whose scheduledFor has arrived; held rows stay put. */
  async function flushDueQueued() {
    const t = now()
    const rows = await store.list(
      (r) => r.status === 'queued' && r.scheduledFor && new Date(r.scheduledFor) <= t,
    )
    let sent = 0
    let failed = 0
    for (const { conversationId } of rows) {
      const { result } = await sendDispatchNow(conversationId)
      if (result.sent) sent += 1
      else failed += 1
    }
    return { total: rows.length, sent, failed }
  }

  const listDispatches = ({ status } = {}) => store.list((r) => !status || r.status === status)

  return {
    upsertDispatch,
    sendDispatchNow,
    recordManualDispatchSent,
    getDispatch,
    flushDispatches,
    flushDueQueued,
    listDispatches,
  }
}
