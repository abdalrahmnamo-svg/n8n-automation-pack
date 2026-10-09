// POST a synthetic revocation payload to the Feedback Revocation webhook.
//   node scripts/trigger-revocation.mjs [--test] [--repeat]
import { buildRevocationPayload } from '../server/n8nRevocation.js'
import { createWebhookSender } from '../server/webhookClient.js'
import { createDispatchService, createMemoryStore } from '../server/feedbackDispatchService.js'
import { parseFlags, secret, webhookUrl } from './lib/trigger.mjs'

const flags = parseFlags()
const url = webhookUrl('feedback-revocation.json', flags)

const conversation = {
  conversationId: 'Customer 0042_2026-01-15_1',
  agent: 'Agent Alpha',
  agentEmail: 'agent.alpha@example.com',
  contact: 'Customer 0042',
  contactPhone: '+1 555 0142',
  date: '2026-01-15',
}
const payload = buildRevocationPayload({ conversation, revokedScore: { totalScore: 92, passed: true } })

// Reuse the outbox for retry/backoff and duplicate suppression.
const service = createDispatchService({
  store: createMemoryStore(),
  send: createWebhookSender({ url, secret: secret() }),
})
await service.upsertDispatch({ conversationId: conversation.conversationId, payload })

console.log(`POST ${url}`)
const first = await service.sendDispatchNow(conversation.conversationId)
console.log('first call :', first.result)
if (flags.repeat) {
  const second = await service.sendDispatchNow(conversation.conversationId)
  console.log('second call:', second.result)
}
process.exitCode = first.result.sent ? 0 : 1
