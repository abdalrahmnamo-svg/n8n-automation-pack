// POST a synthetic feedback payload to the QA Feedback Email webhook.
//   node scripts/trigger-feedback.mjs [--test] [--repeat]
// Goes through the dispatch service (idempotency + retry/backoff); --repeat sends twice
// to show that the second call is suppressed.
import { buildFeedbackPayload } from '../server/n8nFeedback.js'
import { createWebhookSender } from '../server/webhookClient.js'
import { createDispatchService, createMemoryStore } from '../server/feedbackDispatchService.js'
import { parseFlags, secret, webhookUrl } from './lib/trigger.mjs'

const flags = parseFlags()
const url = webhookUrl('qa-feedback-email.json', flags)

const conversation = {
  conversationId: 'Customer 0042_2026-01-15_1',
  agent: 'Agent Alpha',
  agentEmail: 'agent.alpha@example.com',
  contact: 'Customer 0042',
  contactPhone: '+1 555 0142',
  date: '2026-01-15',
}
const score = {
  totalScore: 92,
  passed: true,
  comments: 'great empathy and clear next steps!!',
  scoredBy: 'QA Supervisor',
}

const payload = buildFeedbackPayload({ conversation, score, guidelines: [] })
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
