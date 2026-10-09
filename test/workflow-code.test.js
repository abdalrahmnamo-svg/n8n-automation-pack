/** Runs the Code nodes embedded in the workflows, so the logic is tested without n8n. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCodeNode, conversation } from './helpers.js'
import { buildFeedbackPayload } from '../server/n8nFeedback.js'
import { buildRevocationPayload } from '../server/n8nRevocation.js'

describe('Build feedback email (Code node)', () => {
  const body = buildFeedbackPayload({
    conversation,
    score: { totalScore: 100, passed: true, comments: 'perfect!!', scoredBy: 'QA Supervisor' },
    guidelines: [],
    rng: () => 0.5,
  })

  it('fills the customer name, cleans feedback and sets the key', () => {
    const out = runCodeNode('qa-feedback-email.json', 'Build feedback email', body)
    assert.match(out.finalEmailBody, /- Customer Name: Customer 0042/)
    assert.match(out.finalEmailBody, /- Customer Phone Number: \+1 555 0142/)
    assert.match(out.finalEmailBody, /\nPerfect!\n/)
    assert.equal(out.feedbackType, 'positive')
    assert.equal(out.idempotencyKey, 'feedback:Customer 0042_2026-01-15_1')
    assert.equal(out.emailSubject, 'Quality feedback - Agent Alpha')
  })

  it('rejects a payload without a recipient', () => {
    assert.throws(() => runCodeNode('qa-feedback-email.json', 'Build feedback email', { conversationId: 'x' }), /agentEmail/)
  })
})

describe('Build apology email (Code node)', () => {
  it('uses finalEmailBody when provided', () => {
    const body = buildRevocationPayload({ conversation, revokedScore: { totalScore: 22 } })
    const out = runCodeNode('feedback-revocation.json', 'Build apology email', body)
    assert.equal(out.finalEmailBody, body.finalEmailBody)
    assert.equal(out.idempotencyKey, 'revocation:Customer 0042_2026-01-15_1')
    assert.equal(out.feedbackType, 'revocation')
  })

  it('falls back to a generated apology', () => {
    const out = runCodeNode('feedback-revocation.json', 'Build apology email', {
      agent: 'Agent Alpha',
      agentEmail: 'agent.alpha@example.com',
      conversationId: 'c9',
      contact: 'Customer 0042',
      date: '2026-01-15',
      revokedScore: 22,
    })
    assert.match(out.finalEmailBody, /Please disregard/)
    assert.match(out.finalEmailBody, /22\/100/)
    assert.match(out.finalEmailBody, /QA Team$/)
  })
})

describe('Parse roster (Code node)', () => {
  it('expands day ranges and day-off parts into dated rows', () => {
    const out = runCodeNode('schedule-ingest.json', 'Parse roster', {
      rawText: 'Week 2026-06-07\nAgent Alpha: Sun-Tue 09:00-16:00, Wed-Thu off',
    })
    assert.equal(out.weekStart, '2026-06-07')
    assert.equal(out.entries.length, 5)
    assert.deepEqual(out.entries[0], { agent: 'Agent Alpha', date: '2026-06-07', start: '09:00', end: '16:00', off: false })
    assert.deepEqual(out.entries[4], { agent: 'Agent Alpha', date: '2026-06-11', off: true })
  })

  it('passes structured entries through and reports unparsed parts', () => {
    const entries = [{ agent: 'Agent Alpha', date: '2026-06-07', start: '09:00', end: '16:00', off: false }]
    assert.deepEqual(runCodeNode('schedule-ingest.json', 'Parse roster', { weekStart: '2026-06-07', entries }).entries, entries)
    const out = runCodeNode('schedule-ingest.json', 'Parse roster', {
      rawText: 'Week 2026-06-07\nAgent Alpha: Mon 09:00-16:00, someday soon',
    })
    assert.equal(out.entries.length, 1)
    assert.equal(out.unparsed.length, 1)
  })

  it('throws when nothing can be parsed', () => {
    assert.throws(() => runCodeNode('schedule-ingest.json', 'Parse roster', { rawText: 'hello' }), /no schedule entries/)
  })
})
