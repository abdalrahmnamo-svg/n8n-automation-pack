import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDispatchService,
  createMemoryStore,
  idempotencyKeyFor,
} from '../server/feedbackDispatchService.js'
import { createWebhookSender } from '../server/webhookClient.js'

function setup(send, opts = {}) {
  const delays = []
  const service = createDispatchService({
    store: createMemoryStore(),
    send,
    sleep: async (ms) => delays.push(ms),
    ...opts,
  })
  return { service, delays }
}

describe('dispatch idempotency', () => {
  it('same key twice sends once', async () => {
    const keys = []
    const { service } = setup(async (_p, meta) => (keys.push(meta.idempotencyKey), { sent: true }))
    await service.upsertDispatch({ conversationId: 'c1', payload: { a: 1 } })
    const first = await service.sendDispatchNow('c1')
    const second = await service.sendDispatchNow('c1')
    assert.equal(first.result.sent, true)
    assert.equal(second.result.code, 'already_sent')
    assert.deepEqual(keys, [idempotencyKeyFor('c1')])
  })

  it('concurrent calls share one in-flight send', async () => {
    let n = 0
    const { service } = setup(async () => {
      n += 1
      await new Promise((r) => setTimeout(r, 10))
      return { sent: true }
    })
    await service.upsertDispatch({ conversationId: 'c1', payload: {} })
    const [a, b] = await Promise.all([service.sendDispatchNow('c1'), service.sendDispatchNow('c1')])
    assert.equal(n, 1)
    assert.equal(a.result.sent, true)
    assert.equal(b.result.sent, true)
  })

  it('send-later rows stay held and are skipped by the due-queue worker', async () => {
    let n = 0
    const { service } = setup(async () => (n++, { sent: true }))
    await service.upsertDispatch({ conversationId: 'held', payload: {}, sendLater: true })
    const out = await service.flushDueQueued()
    assert.equal(out.total, 0)
    assert.equal(n, 0)
    assert.equal((await service.getDispatch('held')).status, 'held')
  })
})

describe('dispatch retry/backoff', () => {
  it('stops after max attempts and marks failed', async () => {
    let n = 0
    const { service, delays } = setup(async () => (n++, { sent: false, retryable: true, reason: 'down' }), {
      maxAttempts: 4,
      baseDelayMs: 100,
    })
    await service.upsertDispatch({ conversationId: 'c1', payload: {} })
    const { result, dispatch } = await service.sendDispatchNow('c1')
    assert.equal(result.sent, false)
    assert.equal(n, 4)
    assert.equal(dispatch.status, 'failed')
    assert.equal(dispatch.attempts, 4)
    assert.deepEqual(delays, [100, 200, 400]) // exponential, no sleep after the last attempt
  })

  it('succeeds on a later attempt', async () => {
    let n = 0
    const { service } = setup(async () => (++n < 3 ? { sent: false, retryable: true } : { sent: true }))
    await service.upsertDispatch({ conversationId: 'c1', payload: {} })
    const { result, dispatch } = await service.sendDispatchNow('c1')
    assert.equal(result.sent, true)
    assert.equal(n, 3)
    assert.equal(dispatch.status, 'sent')
  })

  it('does not retry non-retryable failures (e.g. bad secret)', async () => {
    let n = 0
    const { service } = setup(async () => (n++, { sent: false, retryable: false, reason: 'HTTP 401' }))
    await service.upsertDispatch({ conversationId: 'c1', payload: {} })
    const { dispatch } = await service.sendDispatchNow('c1')
    assert.equal(n, 1)
    assert.equal(dispatch.status, 'failed')
    assert.equal(dispatch.lastError, 'HTTP 401')
  })

  it('failed rows are flushable and recover', async () => {
    let up = false
    const { service } = setup(async () => (up ? { sent: true } : { sent: false, retryable: true }), {
      maxAttempts: 2,
    })
    await service.upsertDispatch({ conversationId: 'c1', payload: {} })
    await service.sendDispatchNow('c1')
    up = true
    const flush = await service.flushDispatches()
    assert.deepEqual({ total: flush.total, sent: flush.sent, failed: flush.failed }, { total: 1, sent: 1, failed: 0 })
  })
})

describe('webhook sender', () => {
  it('sends the secret and idempotency headers; 401 is not retryable, 503 is', async () => {
    const seen = []
    const fake = (status) => async (url, init) => (seen.push(init.headers), { ok: status < 400, status })
    const s401 = await createWebhookSender({ url: 'http://x', secret: 's3', fetchImpl: fake(401) })({}, { idempotencyKey: 'k1' })
    const s503 = await createWebhookSender({ url: 'http://x', secret: 's3', fetchImpl: fake(503) })({})
    assert.equal(seen[0]['x-webhook-secret'], 's3')
    assert.equal(seen[0]['idempotency-key'], 'k1')
    assert.equal(s401.retryable, false)
    assert.equal(s503.retryable, true)
  })

  it('treats network errors as retryable', async () => {
    const out = await createWebhookSender({
      url: 'http://x',
      secret: 's',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })({})
    assert.equal(out.sent, false)
    assert.equal(out.retryable, true)
  })
})
