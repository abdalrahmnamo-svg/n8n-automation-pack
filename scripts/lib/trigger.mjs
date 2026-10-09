import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv, repoRoot } from './env.mjs'

/** Read the webhook path out of a shipped workflow file, e.g. 'qa-feedback-email.json'. */
export function webhookPathOf(file) {
  const wf = JSON.parse(readFileSync(join(repoRoot, 'workflows', file), 'utf8'))
  const node = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook')
  if (!node) throw new Error(`no webhook node in ${file}`)
  return node.parameters.path
}

/** Parse --test (use webhook-test URL) and --repeat flags. */
export function parseFlags(argv = process.argv.slice(2)) {
  return { test: argv.includes('--test'), repeat: argv.includes('--repeat') }
}

export function webhookUrl(file, { test = false } = {}) {
  const env = loadEnv()
  const base = process.env.N8N_BASE_URL || env.N8N_BASE_URL
  return `${base}/${test ? 'webhook-test' : 'webhook'}/${webhookPathOf(file)}`
}

export function secret() {
  return loadEnv().WEBHOOK_SHARED_SECRET
}
