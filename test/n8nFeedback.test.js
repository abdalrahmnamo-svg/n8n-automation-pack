import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFeedbackEmail, buildFeedbackPayload } from '../server/n8nFeedback.js'

describe('n8nFeedback', () => {
  const conversation = {
    conversationId: 'test_conv',
    agent: 'Agent Alpha',
    agentEmail: 'agent.alpha@example.com',
    contact: 'Customer 0042',
    contactPhone: '+1 555 0142',
    date: new Date('2026-06-27'),
  }
  const score = {
    totalScore: 95,
    passed: true,
    comments: 'Great empathy shown',
    scoredBy: 'QA Supervisor',
    agentFeedback: '',
  }

  it('buildFeedbackPayload exposes the field names the workflow expects', () => {
    const payload = buildFeedbackPayload({ conversation, score, guidelines: [] })
    assert.match(payload.emailContent, /Dear Agent Alpha/)
    assert.equal(payload.agentEmail, 'agent.alpha@example.com')
    assert.equal(payload.conversationId, 'test_conv')
    assert.equal(payload.totalScore, 95)
    assert.equal(payload.passed, true)
    assert.equal(payload.comments, 'Great empathy shown')
    assert.ok(payload.timestamp)
    assert.equal('event' in payload, false)
  })

  it('buildFeedbackEmail includes the pass line and score', () => {
    const email = buildFeedbackEmail({ conversation, score, guidelines: [] })
    assert.match(email, /95\/100/)
    assert.match(email, /PASS/)
    assert.match(email, /June 27, 2026/)
  })

  it('shows NEEDS IMPROVEMENT below the threshold', () => {
    const email = buildFeedbackEmail({
      conversation,
      score: { totalScore: 40, comments: 'short answers' },
      guidelines: [],
    })
    assert.match(email, /NEEDS IMPROVEMENT/)
  })

  it('picks keyword-matched guidelines first and always lists three', () => {
    const email = buildFeedbackEmail({
      conversation,
      score: { totalScore: 70, comments: 'Please follow the policy and show empathy' },
      guidelines: [],
      rng: () => 0.5,
    })
    assert.match(email, /Follow internal policies/)
    assert.match(email, /Show empathy/)
    assert.match(email, /3\. /)
  })
})
