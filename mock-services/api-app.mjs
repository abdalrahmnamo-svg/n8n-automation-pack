/**
 * Mock "records" API the workflows call. In-memory only.
 * Every /api/* route requires the shared-secret header; /health is open.
 */
import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'

export const SECRET_HEADER = 'x-webhook-secret'
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const TEAM_WINDOW = { start: '09:00', end: '20:00' }

function secretMatches(given, expected) {
  if (!given || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function validateSchedule({ weekStart, entries }) {
  const errors = []
  const warnings = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart || ''))) {
    errors.push('weekStart must be YYYY-MM-DD')
  } else if (new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 0) {
    warnings.push('weekStart is not a Sunday')
  }
  if (!Array.isArray(entries) || entries.length === 0) errors.push('entries must be a non-empty array')
  for (const [i, e] of (Array.isArray(entries) ? entries : []).entries()) {
    if (!e.agent) errors.push(`entry ${i}: agent is required`)
    if (e.off) continue
    if (!HHMM.test(e.start || '') || !HHMM.test(e.end || '')) {
      errors.push(`entry ${i}: start/end must be HH:mm`)
    } else if (e.start < TEAM_WINDOW.start || e.end > TEAM_WINDOW.end) {
      errors.push(`entry ${i}: outside team window ${TEAM_WINDOW.start}-${TEAM_WINDOW.end}`)
    } else if (e.end <= e.start) {
      errors.push(`entry ${i}: end must be after start`)
    }
  }
  return { errors, warnings }
}

export function createApp({ secret }) {
  const app = new Hono()
  const db = { feedback: [], revocations: [], schedules: new Map() }
  const byKey = new Map() // idempotency-key -> stored record

  app.get('/health', (c) => c.json({ ok: true }))

  app.use('/api/*', async (c, next) => {
    if (!secretMatches(c.req.header(SECRET_HEADER), secret)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })

  // Shared handler for idempotent create endpoints.
  const createRecord = (collection, required) => async (c) => {
    let body
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const missing = required.filter((k) => body?.[k] === undefined || body?.[k] === '')
    if (missing.length) return c.json({ error: `missing fields: ${missing.join(', ')}` }, 400)

    const key = c.req.header('idempotency-key')
    const scopedKey = key ? `${collection}:${key}` : null
    if (scopedKey && byKey.has(scopedKey)) {
      return c.json({ ...byKey.get(scopedKey), duplicate: true }, 200)
    }
    const record = { id: `${collection}-${db[collection].length + 1}`, receivedAt: new Date().toISOString(), ...body }
    db[collection].push(record)
    if (scopedKey) byKey.set(scopedKey, record)
    return c.json({ ...record, duplicate: false }, 201)
  }

  app.post('/api/feedback-records', createRecord('feedback', ['conversationId', 'agentEmail']))
  app.post('/api/revocations', createRecord('revocations', ['conversationId', 'agentEmail']))

  app.post('/api/schedules/draft', async (c) => {
    let body
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const validation = validateSchedule(body || {})
    const schedule = { weekStart: body?.weekStart, rows: Array.isArray(body?.entries) ? body.entries.length : 0 }
    if (validation.errors.length === 0) {
      db.schedules.set(body.weekStart, { ...body, savedAt: new Date().toISOString() })
    }
    return c.json({ schedule, validation, saved: validation.errors.length === 0 }, 200)
  })

  app.get('/api/records', (c) =>
    c.json({
      feedback: db.feedback,
      revocations: db.revocations,
      schedules: [...db.schedules.values()],
    }),
  )

  return app
}
