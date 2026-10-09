/**
 * Guards: an already-sent dispatch must not re-spam; recordManualDispatchSent needs a score.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatchService, createMemoryStore } from '../server/feedbackDispatchService.js'

async function makeService({ scores = [], rows = [], send } = {}) {
  const store = createMemoryStore()
  for (const r of rows) await store.put(r)
  const calls = []
  const service = createDispatchService({
    store,
    send: send || (async (payload, meta) => (calls.push(meta), { sent: true })),
    hasScore: async (id) => scores.includes(id),
    sleep: async () => {},
  })
  return { service, store, calls }
}

describe('sendDispatchNow already_sent guard', () => {
  it('refuses when status is sent and force is false', async () => {
    const { service, calls } = await makeService({
      rows: [{ conversationId: 'c1', status: 'sent', payload: { conversationId: 'c1' }, attempts: 1 }],
    })
    const { result, dispatch } = await service.sendDispatchNow('c1')
    assert.equal(result.code, 'already_sent')
    assert.equal(result.sent, false)
    assert.equal(dispatch.status, 'sent')
    assert.equal(calls.length, 0)
  })

  it('force=true proceeds past already_sent and sends again', async () => {
    const { service, calls } = await makeService({
      rows: [{ conversationId: 'c1', status: 'sent', payload: { conversationId: 'c1' }, attempts: 1 }],
    })
    const { result } = await service.sendDispatchNow('c1', { force: true })
    assert.notEqual(result.code, 'already_sent')
    assert.equal(result.sent, true)
    assert.equal(calls.length, 1)
  })
})

describe('recordManualDispatchSent', () => {
  it('fails without a score', async () => {
    const { service } = await makeService()
    const out = await service.recordManualDispatchSent({ conversationId: 'missing', payload: {} })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'no_score')
  })

  it('marks sent when a score exists', async () => {
    const { service, store } = await makeService({ scores: ['c1'] })
    const out = await service.recordManualDispatchSent({
      conversationId: 'c1',
      payload: { conversationId: 'c1', totalScore: 100 },
      approvedBy: 'QA',
    })
    assert.equal(out.ok, true)
    assert.equal(out.alreadySent, false)
    assert.equal((await store.get('c1')).status, 'sent')
  })

  it('is idempotent when already sent', async () => {
    const { service } = await makeService({
      scores: ['c1'],
      rows: [{ conversationId: 'c1', status: 'sent', attempts: 1 }],
    })
    const out = await service.recordManualDispatchSent({ conversationId: 'c1', payload: {} })
    assert.equal(out.ok, true)
    assert.equal(out.alreadySent, true)
  })
})
