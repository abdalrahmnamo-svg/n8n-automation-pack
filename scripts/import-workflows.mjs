// Import the shipped workflows + demo credentials into a local n8n and publish them.
//   node scripts/import-workflows.mjs [--dry-run] [--no-publish]
//
// Shipped workflow JSON deliberately carries no credential ids. n8n resolves credentials by id,
// so this script seeds the two demo credentials with locally generated ids and injects those ids
// into a TEMP COPY of the workflows before importing. Nothing is written back into the repo, and
// the temp folder (which holds the shared secret) is deleted afterwards.
//
// State lives under N8N_USER_FOLDER (default ./.n8n, git-ignored). Run it with n8n stopped, then
// start n8n: `npx n8n@<version> start`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadEnv, repoRoot, N8N_VERSION } from './lib/env.mjs'

const env = loadEnv()
const userFolder = resolve(repoRoot, env.N8N_USER_FOLDER)
const dry = process.argv.includes('--dry-run')
const publish = !process.argv.includes('--no-publish')

const ids = {
  'Header Auth (demo)': randomBytes(8).toString('hex'),
  'SMTP (demo)': randomBytes(8).toString('hex'),
}
const credentials = [
  {
    id: ids['Header Auth (demo)'],
    name: 'Header Auth (demo)',
    type: 'httpHeaderAuth',
    data: { name: 'x-webhook-secret', value: env.WEBHOOK_SHARED_SECRET },
  },
  {
    id: ids['SMTP (demo)'],
    name: 'SMTP (demo)',
    type: 'smtp',
    data: {
      user: 'demo',
      password: 'demo',
      host: 'localhost',
      port: Number(env.SMTP_PORT),
      secure: false,
      disableStartTls: true,
      hostName: '',
    },
  },
]

const q = (s) => `"${s}"`
function n8n(args, { capture = false } = {}) {
  const cmd = `npx --yes n8n@${N8N_VERSION} ${args}`
  console.log(`> ${cmd}`)
  if (dry) return { status: 0, stdout: '' }
  return spawnSync(cmd, {
    shell: true,
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: {
      ...process.env,
      N8N_USER_FOLDER: userFolder,
      N8N_DIAGNOSTICS_ENABLED: 'false',
      N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    },
  })
}

console.log(`N8N_USER_FOLDER=${userFolder}`)
const tmp = mkdtempSync(join(tmpdir(), 'n8n-import-'))
let code = 0
try {
  writeFileSync(join(tmp, 'credentials.json'), JSON.stringify(credentials))
  const wfDir = join(tmp, 'workflows')
  const src = join(repoRoot, 'workflows')
  mkdirSync(wfDir)
  for (const f of readdirSync(src).filter((x) => x.endsWith('.json'))) {
    const wf = JSON.parse(readFileSync(join(src, f), 'utf8'))
    for (const node of wf.nodes) {
      for (const c of Object.values(node.credentials || {})) c.id = ids[c.name]
    }
    writeFileSync(join(wfDir, f), JSON.stringify(wf, null, 2))
  }

  const steps = [
    `import:credentials --input=${q(join(tmp, 'credentials.json'))}`,
    `import:workflow --separate --input=${q(wfDir)}`,
  ]
  for (const s of steps) {
    const r = n8n(s)
    if (r.status !== 0) throw new Error(`step failed: ${s}`)
  }
  if (publish) {
    const list = n8n('list:workflow', { capture: true })
    const rows = (list.stdout || '').split(/\r?\n/).filter((l) => /^[A-Za-z0-9]+\|/.test(l))
    for (const row of rows) {
      const id = row.split('|')[0]
      if (n8n(`publish:workflow --id=${id}`).status !== 0) throw new Error(`publish failed: ${id}`)
    }
    console.log(`published ${rows.length} workflow(s); start n8n to activate their webhooks.`)
  }
} catch (e) {
  console.error(e.message)
  code = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(code)
