/**
 * Pipeline runner: a tiny local HTTP service that runs a configured list of shell steps in order
 * (for example "sync" then "dbt build") and reports exit codes, durations and the dbt summary.
 *
 * Why this exists: n8n 2.x disables the Execute Command node by default for security, so the
 * workflow calls this runner over HTTP (with the shared-secret header) instead of shelling out.
 *
 *   node mock-services/pipeline-runner.mjs [--fake]
 *
 *   POST /run   header x-webhook-secret   body (optional) {"scenario":"success|dbt-failure"} (fake mode only)
 *   GET  /health
 *
 * Configuration (env):
 *   PIPELINE_STEPS_JSON  JSON array of {name, cmd, cwd?}, runs in order, stops at the first failure
 *   PIPELINE_SYNC_CMD    shorthand: first step, named "sync"   (used when STEPS_JSON is unset)
 *   PIPELINE_DBT_CMD     shorthand: second step, named "dbt"   (its output is scanned for the dbt summary)
 *   PIPELINE_WORKDIR     default working directory for the steps
 *   PIPELINE_RUNNER_PORT default 4020 (127.0.0.1 only)
 *   PIPELINE_FAKE=1      same as --fake: scripted outcomes, nothing is executed
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { loadEnv } from '../scripts/lib/env.mjs'

export const SECRET_HEADER = 'x-webhook-secret'
const TAIL_LINES = 15

function secretMatches(given, expected) {
  if (!given || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Find the last dbt summary line ("Done. PASS=158 WARN=7 ERROR=0 ...") in command output. */
export function parseDbtSummary(output) {
  const matches = [...String(output || '').matchAll(/Done\.\s+PASS=(\d+)\s+WARN=(\d+)\s+ERROR=(\d+)/g)]
  if (matches.length === 0) return null
  const m = matches[matches.length - 1]
  return { pass: Number(m[1]), warn: Number(m[2]), error: Number(m[3]) }
}

const tail = (text) => String(text || '').trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join('\n')

/** Build the step list from env: PIPELINE_STEPS_JSON wins, else SYNC/DBT shorthands. */
export function stepsFromEnv(env = process.env) {
  if (env.PIPELINE_STEPS_JSON) {
    const steps = JSON.parse(env.PIPELINE_STEPS_JSON)
    if (!Array.isArray(steps) || steps.some((s) => !s || !s.name || !s.cmd)) {
      throw new Error('PIPELINE_STEPS_JSON must be an array of {name, cmd, cwd?}')
    }
    return steps
  }
  const steps = []
  if (env.PIPELINE_SYNC_CMD) steps.push({ name: 'sync', cmd: env.PIPELINE_SYNC_CMD })
  if (env.PIPELINE_DBT_CMD) steps.push({ name: 'dbt', cmd: env.PIPELINE_DBT_CMD })
  return steps
}

/** Real executor: runs one shell command, resolves {exitCode, output, durationMs}. Never rejects. */
export function shellExecutor({ workdir } = {}) {
  return (step) =>
    new Promise((resolve) => {
      const started = Date.now()
      let output = ''
      const child = spawn(step.cmd, { shell: true, cwd: step.cwd || workdir || process.cwd(), windowsHide: true })
      child.stdout.on('data', (d) => (output += d))
      child.stderr.on('data', (d) => (output += d))
      child.on('error', (e) => resolve({ exitCode: 127, output: `${output}\n${e.message}`, durationMs: Date.now() - started }))
      child.on('close', (code) => resolve({ exitCode: code ?? 1, output, durationMs: Date.now() - started }))
    })
}

/** Scripted outcomes for tests and demos. Scenarios: success, dbt-failure, sync-failure. */
export const FAKE_SCENARIOS = {
  success: [
    { name: 'sync', exitCode: 0, durationMs: 1200, output: 'synced 3 tables, 1 batch of late rows' },
    {
      name: 'dbt',
      exitCode: 0,
      durationMs: 41000,
      output: '02:00:41  Done. PASS=158 WARN=7 ERROR=0 SKIP=0 NO-OP=0 TOTAL=165',
    },
  ],
  'dbt-failure': [
    { name: 'sync', exitCode: 0, durationMs: 1100, output: 'synced 3 tables' },
    {
      name: 'dbt',
      exitCode: 1,
      durationMs: 38000,
      output:
        '02:00:38  Failure in test not_null_fct_tickets_ticket_key (models/marts/_marts.yml)\n02:00:38  Done. PASS=155 WARN=7 ERROR=3 SKIP=0 NO-OP=0 TOTAL=165',
    },
  ],
  'sync-failure': [{ name: 'sync', exitCode: 2, durationMs: 300, output: 'connection refused by source' }],
}

export function fakeExecutor(scenario) {
  const script = FAKE_SCENARIOS[scenario]
  if (!script) throw new Error(`unknown fake scenario "${scenario}" (use ${Object.keys(FAKE_SCENARIOS).join(', ')})`)
  const byName = new Map(script.map((s) => [s.name, s]))
  return async (step) => byName.get(step.name) ?? { exitCode: 0, output: '', durationMs: 0 }
}

/** Run steps in order with an injected executor; stops at the first non-zero exit. */
export async function runPipeline(steps, execute, { now = () => Date.now(), trigger = null } = {}) {
  const startedAt = new Date(now()).toISOString()
  const t0 = now()
  const results = []
  let failedStep = null
  let dbt = null
  for (const step of steps) {
    if (failedStep) {
      results.push({ name: step.name, status: 'skipped', exitCode: null, durationMs: 0, outputTail: '' })
      continue
    }
    const r = await execute(step)
    const ok = r.exitCode === 0
    const summary = parseDbtSummary(r.output)
    if (summary) dbt = summary
    results.push({
      name: step.name,
      status: ok ? 'ok' : 'failed',
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      outputTail: tail(r.output),
    })
    if (!ok) failedStep = step.name
  }
  const dbtFailed = dbt !== null && dbt.error > 0
  return {
    status: failedStep || dbtFailed ? 'failed' : 'ok',
    trigger,
    startedAt,
    // scripted (fake) steps report their own durations, so never claim less than their sum
    durationMs: Math.max(now() - t0, results.reduce((a, s) => a + s.durationMs, 0)),
    failedStep,
    steps: results,
    dbt,
  }
}

export function createRunnerApp({ secret, steps = [], fake = false, workdir, executor } = {}) {
  const app = new Hono()
  let running = false

  app.get('/health', (c) => c.json({ ok: true, fake }))

  app.post('/run', async (c) => {
    if (!secretMatches(c.req.header(SECRET_HEADER), secret)) return c.json({ error: 'unauthorized' }, 401)
    if (running) return c.json({ error: 'a run is already in progress' }, 409)
    let body = {}
    try {
      body = (await c.req.json()) || {}
    } catch {
      // body is optional
    }
    let execute
    let plan = steps
    if (executor) execute = executor
    else if (fake) {
      const scenario = body.scenario || 'success'
      try {
        execute = fakeExecutor(scenario)
      } catch (e) {
        return c.json({ error: e.message }, 400)
      }
      if (plan.length === 0) plan = FAKE_SCENARIOS[scenario].map(({ name }) => ({ name, cmd: '(fake)' }))
    } else {
      execute = shellExecutor({ workdir })
    }
    if (plan.length === 0) return c.json({ error: 'no steps configured (set PIPELINE_STEPS_JSON or PIPELINE_SYNC_CMD / PIPELINE_DBT_CMD)' }, 500)
    running = true
    try {
      return c.json(await runPipeline(plan, execute, { trigger: typeof body.trigger === 'string' ? body.trigger.slice(0, 40) : null }))
    } finally {
      running = false
    }
  })

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv()
  const fake = process.argv.includes('--fake') || process.env.PIPELINE_FAKE === '1'
  const port = Number(process.env.PIPELINE_RUNNER_PORT || 4020)
  const secret = env.WEBHOOK_SHARED_SECRET
  if (!fake && secret === 'change-me' && process.env.PIPELINE_ALLOW_DEFAULT_SECRET !== '1') {
    console.error('refusing to run real commands with the default secret "change-me": set WEBHOOK_SHARED_SECRET in .env')
    process.exit(1)
  }
  const steps = fake ? [] : stepsFromEnv()
  const app = createRunnerApp({ secret, steps, fake, workdir: process.env.PIPELINE_WORKDIR })
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(
      `pipeline runner on http://127.0.0.1:${port} (${fake ? 'FAKE mode' : `${steps.length} real step(s)`}; header: ${SECRET_HEADER})`,
    )
  })
}
