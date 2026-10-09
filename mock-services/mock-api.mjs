import { serve } from '@hono/node-server'
import { createApp } from './api-app.mjs'
import { loadEnv } from '../scripts/lib/env.mjs'

const env = loadEnv()
const port = Number(env.MOCK_API_PORT)
const app = createApp({ secret: env.WEBHOOK_SHARED_SECRET })

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`mock API listening on http://localhost:${port} (header: x-webhook-secret)`)
})
