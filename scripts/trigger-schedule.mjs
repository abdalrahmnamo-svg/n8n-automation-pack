// POST a synthetic weekly roster (free text) to the Schedule Ingest webhook.
//   node scripts/trigger-schedule.mjs [--test]
import { createWebhookSender } from '../server/webhookClient.js'
import { parseFlags, secret, webhookUrl } from './lib/trigger.mjs'

const flags = parseFlags()
const url = webhookUrl('schedule-ingest.json', flags)

const rawText = [
  'Week 2026-06-07',
  'Agent Alpha: Sun-Thu 09:00-16:00, Fri-Sat off',
  'Agent Bravo: Sun-Wed 11:00-19:00, Thu 09:00-17:00, Fri-Sat off',
].join('\n')

console.log(`POST ${url}`)
const result = await createWebhookSender({ url, secret: secret() })({
  weekStart: '2026-06-07',
  rawText,
  submittedVia: 'script',
})
console.log(result)
process.exitCode = result.sent ? 0 : 1
