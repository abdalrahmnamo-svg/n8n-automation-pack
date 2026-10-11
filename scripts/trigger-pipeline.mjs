// POST to the Nightly Data Pipeline webhook (manual run).
//   node scripts/trigger-pipeline.mjs [--scenario success|dbt-failure|sync-failure] [--test]
// --scenario only has an effect when the pipeline runner was started in --fake mode.
import { createWebhookSender } from '../server/webhookClient.js'
import { parseFlags, secret, webhookUrl } from './lib/trigger.mjs'

const flags = parseFlags()
const i = process.argv.indexOf('--scenario')
const scenario = i > -1 ? process.argv[i + 1] : undefined
const url = webhookUrl('nightly-data-pipeline.json', flags)

console.log(`POST ${url}${scenario ? ` (scenario: ${scenario})` : ''}`)
const result = await createWebhookSender({ url, secret: secret() })({ scenario })
console.log(result)
process.exitCode = result.sent ? 0 : 1
