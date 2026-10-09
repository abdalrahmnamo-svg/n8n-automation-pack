import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRevocationEmail, buildRevocationPayload } from '../server/n8nRevocation.js'

describe('n8nRevocation', () => {
  const conversation = {
    conversationId: 'Customer 0042_2026-01-15_1',
    agent: 'Agent Alpha',
    agentEmail: 'agent.alpha@example.com',
    contact: 'Customer 0042',
    contactPhone: '+1 555 0142',
    date: '2026-01-15',
  }

  it('email mentions disregard, conversation id, revoked score and agent', () => {
    const body = buildRevocationEmail({ conversation, revokedScore: { totalScore: 22, passed: false } })
    assert.match(body, /disregard/)
    assert.match(body, /Customer 0042_2026-01-15_1/)
    assert.match(body, /22\/100/)
    assert.match(body, /Agent Alpha/)
  })

  it('payload carries finalEmailBody and ids for the workflow', () => {
    const payload = buildRevocationPayload({
      conversation,
      revokedScore: { totalScore: 22, passed: false },
    })
    assert.equal(payload.agentEmail, 'agent.alpha@example.com')
    assert.match(payload.finalEmailBody, /QA Team/)
    assert.equal(payload.conversationId, conversation.conversationId)
    assert.equal(payload.revokedScore, 22)
    assert.equal(payload.revokedBy, 'QA Supervisor')
  })

  it('uses a custom apology note when given', () => {
    const body = buildRevocationEmail({ conversation, apologyNote: 'Sorry about that.' })
    assert.match(body, /Sorry about that\./)
    assert.doesNotMatch(body, /incorrect score/)
  })
})
