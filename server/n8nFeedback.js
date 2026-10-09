/**
 * Build the feedback-email payload that the "QA Feedback Email" workflow receives.
 * Pure functions only: sending lives in webhookClient.js / feedbackDispatchService.js.
 */
import { DEFAULT_GUIDELINES, PASS_THRESHOLD } from './defaultGuidelines.js'

function pickRandom(count, pool, rng) {
  const shuffled = [...pool].sort(() => rng() - 0.5)
  return shuffled.slice(0, count)
}

export function selectGuidelines(comments, guidelines, rng = Math.random) {
  const list = Array.isArray(guidelines) && guidelines.length ? guidelines : DEFAULT_GUIDELINES
  if (!comments || !String(comments).trim()) return pickRandom(3, list, rng)

  const lower = String(comments).toLowerCase()
  const matched = list.filter((g) => (g.keywords || []).some((kw) => lower.includes(String(kw).toLowerCase())))

  if (matched.length >= 3) return matched
  if (matched.length > 0) {
    const pool = list.filter((g) => !matched.includes(g))
    return [...matched, ...pickRandom(3 - matched.length, pool, rng)]
  }
  return pickRandom(3, list, rng)
}

function isoDate(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : String(date || '').slice(0, 10)
}

function longDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function buildFeedbackEmail({ conversation, score, guidelines, rng }) {
  const comments = score.comments || score.agentFeedback || ''
  const totalScore = score.totalScore ?? 0
  const passed = score.passed ?? totalScore >= PASS_THRESHOLD
  const selected = selectGuidelines(comments, guidelines, rng)
  const feedback = String(comments).trim() || 'The agent demonstrated good overall performance in this interaction.'

  const guidelinesSection = selected
    .map((g, i) => `${i + 1}. ${g.title}\n   ${g.description}`)
    .join('\n\n')

  return `Dear ${conversation.agent || 'Agent'},

I hope this email finds you well. I wanted to share some feedback regarding your recent interaction with a customer.

Comments / Feedback:
${feedback}

Guidelines:
To continue improving the quality of your interactions, please keep these guidelines in mind:

${guidelinesSection}

Scored Interaction:
- Customer Name:
- Customer Phone Number: ${conversation.contactPhone || 'N/A'}
- Date: ${longDate(isoDate(conversation.date))}

Your total quality score for this interaction: ${totalScore}/100 ${passed ? 'PASS' : 'NEEDS IMPROVEMENT'}

${
  passed
    ? "Keep up the great work, and don't hesitate to reach out if you have any questions about this feedback."
    : 'Please go through the communication guidelines again and let me know if you have any questions or need support applying them.'
}

Best regards,
Quality Assurance Team`
}

export function buildFeedbackPayload({ conversation, score, guidelines, rng, now = () => new Date() }) {
  return {
    emailContent: buildFeedbackEmail({ conversation, score, guidelines, rng }),
    agent: conversation.agent || '',
    agentEmail: conversation.agentEmail || '',
    conversationId: conversation.conversationId,
    contact: conversation.contact || '',
    phone: conversation.contactPhone || 'N/A',
    date: isoDate(conversation.date),
    totalScore: score.totalScore,
    passed: score.passed,
    scoredBy: score.scoredBy || 'QA Supervisor',
    comments: score.comments || '',
    agentFeedback: score.agentFeedback || '',
    timestamp: now().toISOString(),
  }
}
