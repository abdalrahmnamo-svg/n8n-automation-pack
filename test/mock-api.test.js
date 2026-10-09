import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../mock-services/api-app.mjs'

const SECRET = 'test-secret'
const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const auth = { 'x-webhook-secret': SECRET }

describe('mock API auth', () => {
  const app = createApp({ secret: SECRET })

  it('rejects requests without the header secret', async () => {
    for (const path of ['/api/feedback-records', '/api/revocations', '/api/schedules/draft']) {
      const res = await app.request(path, json({ conversationId: 'c', agentEmail: 'a@example.com' }))
      assert.equal(res.status, 401, path)
    }
    assert.equal((await app.request('/api/records')).status, 401)
  })

  it('rejects a wrong secret', async () => {
    const res = await app.request('/api/feedback-records', json({}, { 'x-webhook-secret': 'nope' }))
    assert.equal(res.status, 401)
  })

  it('health is open', async () => {
    assert.equal((await app.request('/health')).status, 200)
  })
})

describe('mock API records', () => {
  it('stores a feedback record and suppresses a duplicate idempotency key', async () => {
    const app = createApp({ secret: SECRET })
    const body = { conversationId: 'c1', agentEmail: 'a@example.com' }
    const headers = { ...auth, 'idempotency-key': 'feedback:c1' }
    const r1 = await app.request('/api/feedback-records', json(body, headers))
    const r2 = await app.request('/api/feedback-records', json(body, headers))
    assert.equal(r1.status, 201)
    assert.equal((await r1.json()).duplicate, false)
    assert.equal(r2.status, 200)
    assert.equal((await r2.json()).duplicate, true)
    const all = await (await app.request('/api/records', { headers: auth })).json()
    assert.equal(all.feedback.length, 1)
  })

  it('validates required fields', async () => {
    const app = createApp({ secret: SECRET })
    const res = await app.request('/api/revocations', json({ conversationId: 'c1' }, auth))
    assert.equal(res.status, 400)
  })

  it('validates and stores a schedule draft', async () => {
    const app = createApp({ secret: SECRET })
    const good = {
      weekStart: '2026-06-07',
      entries: [
        { agent: 'Agent Alpha', date: '2026-06-07', start: '09:00', end: '16:00', off: false },
        { agent: 'Agent Alpha', date: '2026-06-12', off: true },
      ],
    }
    const ok = await (await app.request('/api/schedules/draft', json(good, auth))).json()
    assert.equal(ok.saved, true)
    assert.equal(ok.schedule.rows, 2)
    assert.deepEqual(ok.validation.errors, [])

    const bad = {
      weekStart: '2026-06-07',
      entries: [{ agent: 'Agent Alpha', date: '2026-06-07', start: '06:00', end: '16:00', off: false }],
    }
    const out = await (await app.request('/api/schedules/draft', json(bad, auth))).json()
    assert.equal(out.saved, false)
    assert.match(out.validation.errors[0], /outside team window/)
  })
})
