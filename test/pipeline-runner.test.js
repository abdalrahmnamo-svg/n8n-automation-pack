import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDbtSummary, runPipeline, stepsFromEnv, createRunnerApp, shellExecutor } from '../mock-services/pipeline-runner.mjs'

const SECRET = 'test-secret'
const auth = { 'x-webhook-secret': SECRET }
const post = (body, headers = auth) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

describe('parseDbtSummary', () => {
  it('reads PASS/WARN/ERROR from a timestamped dbt line', () => {
    assert.deepEqual(parseDbtSummary('02:00:41  Done. PASS=158 WARN=7 ERROR=0 SKIP=0 NO-OP=0 TOTAL=165'), {
      pass: 158,
      warn: 7,
      error: 0,
    })
  })

  it('uses the last summary line and handles CRLF output', () => {
    const out = 'Done. PASS=1 WARN=0 ERROR=0 TOTAL=1\r\nmore\r\n12:00:00  Done. PASS=150 WARN=2 ERROR=3 SKIP=0 TOTAL=155\r\n'
    assert.deepEqual(parseDbtSummary(out), { pass: 150, warn: 2, error: 3 })
  })

  it('returns null when there is no summary', () => {
    assert.equal(parseDbtSummary('Completed successfully'), null)
    assert.equal(parseDbtSummary(''), null)
    assert.equal(parseDbtSummary(undefined), null)
  })
})

describe('stepsFromEnv', () => {
  it('prefers PIPELINE_STEPS_JSON, else the SYNC/DBT shorthands', () => {
    const json = JSON.stringify([{ name: 'a', cmd: 'echo a' }])
    assert.deepEqual(stepsFromEnv({ PIPELINE_STEPS_JSON: json, PIPELINE_SYNC_CMD: 'x' }), [{ name: 'a', cmd: 'echo a' }])
    assert.deepEqual(stepsFromEnv({ PIPELINE_SYNC_CMD: 's', PIPELINE_DBT_CMD: 'd' }), [
      { name: 'sync', cmd: 's' },
      { name: 'dbt', cmd: 'd' },
    ])
    assert.deepEqual(stepsFromEnv({}), [])
    assert.throws(() => stepsFromEnv({ PIPELINE_STEPS_JSON: '[{"name":"x"}]' }), /must be an array/)
  })
})

describe('runPipeline', () => {
  const steps = [{ name: 'sync', cmd: 's' }, { name: 'dbt', cmd: 'd' }, { name: 'after', cmd: 'a' }]

  it('stops at the first failing step and skips the rest', async () => {
    const exec = async (s) => ({ exitCode: s.name === 'dbt' ? 1 : 0, output: s.name === 'dbt' ? 'Done. PASS=5 WARN=0 ERROR=2' : 'ok', durationMs: 10 })
    const r = await runPipeline(steps, exec)
    assert.equal(r.status, 'failed')
    assert.equal(r.failedStep, 'dbt')
    assert.deepEqual(r.steps.map((s) => s.status), ['ok', 'failed', 'skipped'])
    assert.deepEqual(r.dbt, { pass: 5, warn: 0, error: 2 })
  })

  it('reports failed when dbt errors > 0 even with exit code 0', async () => {
    const exec = async () => ({ exitCode: 0, output: 'Done. PASS=5 WARN=0 ERROR=1', durationMs: 1 })
    const r = await runPipeline(steps.slice(0, 2), exec)
    assert.equal(r.status, 'failed')
    assert.equal(r.failedStep, null)
  })

  it('executes real shell commands and captures exit codes', async () => {
    const run = shellExecutor()
    const ok = await run({ name: 'ok', cmd: 'node -e "console.log(\'Done. PASS=2 WARN=1 ERROR=0\')"' })
    assert.equal(ok.exitCode, 0)
    assert.deepEqual(parseDbtSummary(ok.output), { pass: 2, warn: 1, error: 0 })
    const bad = await run({ name: 'bad', cmd: 'node -e "process.exit(3)"' })
    assert.equal(bad.exitCode, 3)
  })
})

describe('runner HTTP app', () => {
  const app = createRunnerApp({ secret: SECRET, fake: true })

  it('requires the secret header', async () => {
    assert.equal((await app.request('/run', post({}, {}))).status, 401)
    assert.equal((await app.request('/run', post({}, { 'x-webhook-secret': 'nope' }))).status, 401)
    assert.equal((await app.request('/health')).status, 200)
  })

  it('fake mode: success scenario (default)', async () => {
    const res = await app.request('/run', post({ trigger: 'manual' }))
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.status, 'ok')
    assert.equal(body.trigger, 'manual')
    assert.deepEqual(body.dbt, { pass: 158, warn: 7, error: 0 })
    assert.deepEqual(body.steps.map((s) => [s.name, s.status, s.exitCode]), [['sync', 'ok', 0], ['dbt', 'ok', 0]])
  })

  it('fake mode: dbt test failure scenario', async () => {
    const body = await (await app.request('/run', post({ scenario: 'dbt-failure' }))).json()
    assert.equal(body.status, 'failed')
    assert.equal(body.failedStep, 'dbt')
    assert.deepEqual(body.dbt, { pass: 155, warn: 7, error: 3 })
    assert.match(body.steps[1].outputTail, /not_null_fct_tickets_ticket_key/)
  })

  it('fake mode: rejects an unknown scenario', async () => {
    assert.equal((await app.request('/run', post({ scenario: 'nope' }))).status, 400)
  })

  it('real mode with no steps configured is a 500, not a silent success', async () => {
    const real = createRunnerApp({ secret: SECRET, steps: [] })
    assert.equal((await real.request('/run', post({}))).status, 500)
  })

  it('real mode runs the configured steps', async () => {
    const real = createRunnerApp({
      secret: SECRET,
      steps: [
        { name: 'sync', cmd: 'node -e "console.log(1)"' },
        { name: 'dbt', cmd: 'node -e "console.log(\'Done. PASS=9 WARN=0 ERROR=0\')"' },
      ],
    })
    const body = await (await real.request('/run', post({}))).json()
    assert.equal(body.status, 'ok')
    assert.deepEqual(body.dbt, { pass: 9, warn: 0, error: 0 })
  })

  it('rejects an overlapping run with 409', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const busy = createRunnerApp({ secret: SECRET, steps: [{ name: 'x', cmd: 'x' }], executor: async () => (await gate, { exitCode: 0, output: '', durationMs: 1 }) })
    const first = busy.request('/run', post({}))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal((await busy.request('/run', post({}))).status, 409)
    release()
    assert.equal((await first).status, 200)
  })
})
