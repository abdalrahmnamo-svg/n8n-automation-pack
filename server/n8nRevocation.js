/**
 * Build the payload for the "Feedback Revocation" workflow: an apology / disregard
 * email sent when a mistaken approval is reversed.
 */

const SIGNOFF = 'QA Team'

function isoDate(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : String(date || '').slice(0, 10)
}

export function buildRevocationEmail({ conversation, apologyNote, revokedScore }) {
  const agent = conversation.agent || 'Agent'
  const contact = conversation.contact || 'the customer'
  const dateStr = isoDate(conversation.date)
  const formattedDate = dateStr
    ? new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : 'the listed date'

  const note =
    apologyNote ||
    `Please disregard the quality feedback email we sent regarding your interaction with ${contact} on ${formattedDate}. That score was approved in error and has been removed from the system. Your performance numbers have been updated accordingly. We apologize for any confusion.`

  const scoreLine =
    revokedScore?.totalScore != null
      ? `\nThe incorrect score (${revokedScore.totalScore}/100) no longer appears on your record.`
      : ''

  return `Dear ${agent},

${note}${scoreLine}

Conversation reference: ${conversation.conversationId}
Customer: ${contact}
Customer Phone Number: ${conversation.contactPhone || 'N/A'}
Date: ${formattedDate}

Best regards,
${SIGNOFF}`
}

export function buildRevocationPayload({
  conversation,
  apologyNote,
  revokedScore,
  revokedBy = 'QA Supervisor',
  now = () => new Date(),
}) {
  return {
    agent: conversation.agent || '',
    agentEmail: conversation.agentEmail || '',
    conversationId: conversation.conversationId,
    contact: conversation.contact || '',
    phone: conversation.contactPhone || 'N/A',
    date: isoDate(conversation.date),
    apologyNote: apologyNote || '',
    revokedScore: revokedScore?.totalScore ?? null,
    revokedPassed: revokedScore?.passed ?? null,
    revokedBy,
    timestamp: now().toISOString(),
    finalEmailBody: buildRevocationEmail({ conversation, apologyNote, revokedScore }),
  }
}
