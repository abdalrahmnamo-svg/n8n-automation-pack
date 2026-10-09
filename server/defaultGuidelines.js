/**
 * Synthetic guideline pool used when building feedback emails.
 * Each entry has keywords that are matched against the reviewer's comment.
 */
export const PASS_THRESHOLD = 80

export const DEFAULT_GUIDELINES = [
  {
    title: 'Follow internal policies',
    description: 'Make sure every response and action respects the documented policies and processes.',
    keywords: ['policy', 'rule', 'process'],
  },
  {
    title: 'Avoid short or one-word answers',
    description: 'Provide complete, informative responses so the customer does not feel dismissed.',
    keywords: ['short', 'brief', 'one-word', 'dismissive'],
  },
  {
    title: 'Investigate properly',
    description: 'Read previous tickets and history first so answers are accurate and professional.',
    keywords: ['investigate', 'history', 'ticket', 'accurate'],
  },
  {
    title: 'Show empathy',
    description: 'Acknowledge the customer\'s situation before moving on to the solution.',
    keywords: ['empathy', 'tone', 'frustrated', 'apolog'],
  },
  {
    title: 'Confirm next steps',
    description: 'End each interaction by stating what happens next and who owns it.',
    keywords: ['next step', 'follow up', 'follow-up', 'closing'],
  },
]
