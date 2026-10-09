import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadWorkflow(file) {
  return JSON.parse(readFileSync(join(root, 'workflows', file), 'utf8'))
}

/** Run a workflow Code node ("run once for each item") outside n8n. */
export function runCodeNode(file, nodeName, body) {
  const node = loadWorkflow(file).nodes.find((n) => n.name === nodeName)
  if (!node) throw new Error(`node ${nodeName} not found in ${file}`)
  const fn = new Function('$input', node.parameters.jsCode)
  return fn({ item: { json: { body } } }).json
}

export const conversation = {
  conversationId: 'Customer 0042_2026-01-15_1',
  agent: 'Agent Alpha',
  agentEmail: 'agent.alpha@example.com',
  contact: 'Customer 0042',
  contactPhone: '+1 555 0142',
  date: '2026-01-15',
}
