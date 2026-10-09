import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFiles, checkWorkflow } from '../scripts/check-workflows.mjs'
import { loadWorkflow } from './helpers.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = ['qa-feedback-email.json', 'feedback-revocation.json', 'schedule-ingest.json']

describe('check-workflows', () => {
  it('passes on the shipped workflow JSON', () => {
    const { files, problems } = checkFiles([join(root, 'workflows')])
    assert.equal(files.length, 3)
    assert.deepEqual(problems, [])
  })

  const mutate = (fn) => {
    const wf = structuredClone(loadWorkflow('qa-feedback-email.json'))
    fn(wf)
    return checkWorkflow(wf, { name: 'fixture' })
  }
  const hits = (problems, rule) => problems.some((p) => p.includes(`[${rule}]`))

  it('fails on a fixture containing pinData', () => {
    const problems = mutate((wf) => {
      wf.pinData = { Webhook: [{ json: {} }] }
    })
    assert.ok(hits(problems, 'forbidden-key'))
  })

  for (const key of ['instanceId', 'versionId', 'staticData']) {
    it(`fails on ${key}`, () => {
      const problems = mutate((wf) => {
        wf.meta = { [key]: 'x' }
        wf[key] = 'x'
      })
      assert.ok(problems.length > 0)
    })
  }

  it('fails on a workflow root id', () => {
    assert.ok(hits(mutate((wf) => (wf.id = 'abc123')), 'root-id'))
  })

  it('fails on a credential id', () => {
    const problems = mutate((wf) => {
      wf.nodes.find((n) => n.credentials).credentials.smtp = { id: 'AbC', name: 'SMTP (demo)' }
    })
    assert.ok(hits(problems, 'credential-id'))
  })

  it('fails on a non-example email', () => {
    const problems = mutate((wf) => (wf.nodes[0].parameters.content += ' a@other.test'))
    assert.ok(hits(problems, 'email'))
  })

  it('fails on a foreign host and a forbidden service term', () => {
    const problems = mutate((wf) => (wf.nodes[0].parameters.content += ' https://files.sharepoint.com/x'))
    assert.ok(hits(problems, 'host'))
    assert.ok(hits(problems, 'forbidden-text'))
  })

  it('fails on a vendor node type and a non-webhook trigger', () => {
    const problems = mutate((wf) => wf.nodes.push({ id: crypto.randomUUID(), name: 'T', type: 'n8n-nodes-base.telegramTrigger' }))
    assert.ok(hits(problems, 'node-type'))
    assert.ok(hits(problems, 'trigger'))
  })

  it('fails when a webhook lacks header auth or has a non-UUID path', () => {
    const noAuth = mutate((wf) => {
      wf.nodes.find((n) => n.type.endsWith('webhook')).parameters.authentication = 'none'
    })
    assert.ok(hits(noAuth, 'webhook-auth'))
    const badPath = mutate((wf) => {
      wf.nodes.find((n) => n.type.endsWith('webhook')).parameters.path = 'my-hook'
    })
    assert.ok(hits(badPath, 'webhook-path'))
  })

  it('applies extra denylist terms', () => {
    const wf = loadWorkflow('qa-feedback-email.json')
    const problems = checkWorkflow(wf, { name: 'fixture', extraTerms: ['feedback'] })
    assert.ok(hits(problems, 'forbidden-text'))
  })

  it('every shipped webhook uses header auth and a unique path', () => {
    const paths = FILES.flatMap((f) =>
      loadWorkflow(f)
        .nodes.filter((n) => n.type === 'n8n-nodes-base.webhook')
        .map((n) => {
          assert.equal(n.parameters.authentication, 'headerAuth')
          return n.parameters.path
        }),
    )
    assert.equal(new Set(paths).size, 3)
  })
})
