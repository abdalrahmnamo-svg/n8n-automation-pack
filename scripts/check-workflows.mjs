/**
 * Workflow sanitizer check. Fails (exit 1) when an exported n8n workflow carries anything
 * that should never be published: instance/credential/file IDs, pinned execution data,
 * non-example emails, vendor-specific nodes, foreign hosts, or unauthenticated webhooks.
 *
 *   node scripts/check-workflows.mjs [dir-or-file ...] [--denylist <file>]
 *
 * --denylist (or env DENYLIST_FILE) points at a private file of extra terms, one per line
 * (names, domains, brands). The terms themselves are never stored in this repo.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Keys that must not appear at any depth.
const FORBIDDEN_KEYS = [
  'pinData',
  'instanceId',
  'versionId',
  'activeVersionId',
  'versionCounter',
  'staticData',
  'shared',
  'projectId',
  'homeProject',
  'triggerCount',
  'cachedResultUrl',
  'cachedResultName',
]

// Node types that tie a workflow to a vendor/service we replaced with local mocks.
const FORBIDDEN_NODE_TYPE = /microsoft|outlook|excel|sharepoint|onedrive|telegram|openai|googlesheets|slack|gmail/i

// Words that must not appear anywhere in the file text (case-insensitive).
const FORBIDDEN_TEXT = [
  'sharepoint',
  'onedrive',
  'ngrok',
  'telegram',
  'openai',
  'microsoft',
  'outlook',
  'office365',
  'graph.microsoft',
  'api.telegram',
]

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1'])

function walk(value, visit, path = '$') {
  visit(value, path)
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, visit, `${path}.${k}`)
  }
}

export function checkWorkflow(wf, { name = 'workflow', extraTerms = [] } = {}) {
  const problems = []
  const fail = (rule, detail) => problems.push(`${name}: [${rule}] ${detail}`)
  const text = JSON.stringify(wf)

  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) {
    fail('shape', 'not an n8n workflow object (missing nodes[])')
    return problems
  }

  // Root-level identifiers.
  if ('id' in wf) fail('root-id', 'workflow root must not carry an id')
  if ('meta' in wf && wf.meta && 'instanceId' in wf.meta) fail('instanceId', 'meta.instanceId present')
  if (Array.isArray(wf.tags) && wf.tags.some((t) => t && typeof t === 'object' && 'id' in t)) {
    fail('tags', 'tags must not carry ids')
  }
  if (!/^[A-Z][A-Za-z ]+$/.test(wf.name || '')) fail('name', `workflow name should be generic title text, got "${wf.name}"`)

  walk(wf, (v, path) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.includes(k)) fail('forbidden-key', `${k} at ${path}`)
      }
      // credentials: { type: { id, name } } -> id is forbidden
      if (/\.credentials$/.test(path)) {
        for (const [ctype, c] of Object.entries(v)) {
          if (c && typeof c === 'object' && 'id' in c) fail('credential-id', `${ctype}.id at ${path}`)
          if (c && typeof c === 'object' && !/\(demo\)$/.test(c.name || '')) {
            fail('credential-name', `${ctype} name must be generic and end in "(demo)" at ${path}`)
          }
        }
      }
    }
  })

  // Emails: everything must be @example.com.
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    if (m[1].toLowerCase() !== 'example.com') fail('email', `non-example address ${m[0]}`)
  }

  // Hosts: only localhost URLs.
  for (const m of text.matchAll(/https?:\/\/([^\s/"'\\:]+)/gi)) {
    if (!ALLOWED_HOSTS.has(m[1].toLowerCase())) fail('host', `non-local URL host ${m[1]}`)
  }

  const lower = text.toLowerCase()
  for (const term of [...FORBIDDEN_TEXT, ...extraTerms.map((t) => t.toLowerCase())]) {
    if (term && lower.includes(term)) fail('forbidden-text', `contains "${term}"`)
  }

  // Nodes.
  const seenIds = new Set()
  for (const n of wf.nodes) {
    const label = `node "${n.name}"`
    if (FORBIDDEN_NODE_TYPE.test(n.type || '')) fail('node-type', `${label} uses ${n.type}`)
    if (n.id && !UUID_RE.test(n.id)) fail('node-id', `${label} id is not a UUID`)
    if (n.id && seenIds.has(n.id)) fail('node-id', `${label} duplicate id`)
    seenIds.add(n.id)

    if (n.type === 'n8n-nodes-base.webhook') {
      if (n.parameters?.authentication !== 'headerAuth') fail('webhook-auth', `${label} must use headerAuth`)
      if (!n.credentials?.httpHeaderAuth) fail('webhook-auth', `${label} has no httpHeaderAuth credential`)
      if (!UUID_RE.test(n.parameters?.path || '')) fail('webhook-path', `${label} path must be a fresh UUID`)
      if (!UUID_RE.test(n.webhookId || '')) fail('webhook-id', `${label} webhookId must be a UUID`)
      else if (n.webhookId !== n.parameters.path) fail('webhook-id', `${label} webhookId should equal path`)
    }
    if (/trigger$/i.test(n.type || '') && n.type !== 'n8n-nodes-base.webhook') {
      fail('trigger', `${label} is a non-webhook trigger (${n.type})`)
    }
  }
  return problems
}

export function checkFiles(paths, { extraTerms = [] } = {}) {
  const files = []
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) if (f.endsWith('.json')) files.push(join(p, f))
    } else files.push(p)
  }
  const problems = []
  if (files.length === 0) problems.push('no workflow JSON files found')
  for (const f of files) {
    let wf
    try {
      wf = JSON.parse(readFileSync(f, 'utf8'))
    } catch (e) {
      problems.push(`${f}: invalid JSON (${e.message})`)
      continue
    }
    problems.push(...checkWorkflow(wf, { name: f.split(/[\\/]/).pop(), extraTerms }))
  }
  return { files, problems }
}

function loadTerms(file) {
  if (!file || !existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let denylist = process.env.DENYLIST_FILE
  const targets = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--denylist') denylist = args[++i]
    else targets.push(args[i])
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { files, problems } = checkFiles(targets.length ? targets : [join(root, 'workflows')], {
    extraTerms: loadTerms(denylist),
  })
  if (problems.length) {
    console.error(`check-workflows FAILED (${problems.length} problem(s)):`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`check-workflows OK: ${files.length} file(s) clean`)
}
