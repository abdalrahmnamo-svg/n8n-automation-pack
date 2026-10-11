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

describe('Evaluate run (Code node, nightly pipeline)', () => {
  const okRun = {
    status: 'ok',
    trigger: 'manual',
    startedAt: '2026-06-08T02:00:00.000Z',
    durationMs: 42200,
    failedStep: null,
    dbt: { pass: 158, warn: 7, error: 0 },
    steps: [
      { name: 'sync', status: 'ok', exitCode: 0, durationMs: 1200, outputTail: '' },
      { name: 'dbt', status: 'ok', exitCode: 0, durationMs: 41000, outputTail: '' },
    ],
  }
  const run = (body) => runCodeNode('nightly-data-pipeline.json', 'Evaluate run', body)

  it('builds an OK summary', () => {
    const out = run(okRun)
    assert.equal(out.failed, false)
    assert.equal(out.subject, 'Nightly data pipeline OK (dbt PASS=158, WARN=7)')
    assert.match(out.text, /- dbt: ok \(exit 0, 41\.0s\)/)
    assert.match(out.text, /dbt: PASS=158 WARN=7 ERROR=0/)
    assert.equal(out.run.status, 'ok')
    assert.equal(out.run.steps[0].outputTail, undefined)
  })

  it('flags a failed step with dbt counts and the last output', () => {
    const out = run({
      ...okRun,
      status: 'failed',
      failedStep: 'dbt',
      dbt: { pass: 155, warn: 7, error: 3 },
      steps: [okRun.steps[0], { name: 'dbt', status: 'failed', exitCode: 1, durationMs: 38000, outputTail: 'Failure in test not_null_x' }],
    })
    assert.equal(out.failed, true)
    assert.equal(out.failedStep, 'dbt')
    assert.equal(out.subject, 'Nightly data pipeline FAILED at dbt (dbt errors: 3)')
    assert.match(out.text, /dbt: PASS=155 WARN=7 ERROR=3/)
    assert.match(out.text, /Last output of dbt:\nFailure in test not_null_x/)
  })

  it('treats dbt errors > 0 as failed even when the status says ok', () => {
    assert.equal(run({ ...okRun, dbt: { pass: 1, warn: 0, error: 1 } }).failed, true)
  })

  it('treats an unreachable runner (error item) as failed', () => {
    const out = run({ error: { message: 'connect ECONNREFUSED 127.0.0.1:4020' } })
    assert.equal(out.failed, true)
    assert.equal(out.failedStep, 'runner')
    assert.match(out.text, /did not return a result: connect ECONNREFUSED/)
  })

  it('treats a missing status as failed', () => {
    assert.equal(run({ steps: [] }).failed, true)
  })
})
