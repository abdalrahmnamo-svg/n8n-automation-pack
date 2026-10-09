/**
 * Local SMTP catcher: accepts any message, keeps it in memory, and serves a tiny
 * HTML inbox. Stand-in for a real mail server so the workflows can "send" email.
 *
 *   SMTP  : localhost:2525   (SMTP_PORT)
 *   Inbox : http://localhost:8025        JSON: http://localhost:8025/messages.json
 */
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const addrs = (a) => (a?.value || []).map((x) => x.address).join(', ')

export function renderInbox(messages) {
  const items = messages
    .map(
      (m) => `<article><h2>${esc(m.subject)}</h2>
<p><b>To:</b> ${esc(m.to)} &middot; <b>Cc:</b> ${esc(m.cc)} &middot; <b>From:</b> ${esc(m.from)} &middot; ${esc(m.receivedAt)}</p>
<pre>${esc(m.text)}</pre></article>`,
    )
    .reverse()
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local inbox</title>
<style>body{font:14px system-ui;margin:2rem auto;max-width:760px}article{border:1px solid #ccc;border-radius:6px;padding:1rem;margin:1rem 0}pre{white-space:pre-wrap}</style>
</head><body><h1>Local inbox (${messages.length})</h1>${items || '<p>No messages yet.</p>'}</body></html>`
}

export async function createCatcher({ smtpPort = 2525, httpPort = 8025, host = '127.0.0.1' } = {}) {
  const messages = []

  const smtp = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) {
      cb(null, { user: auth.username || 'demo' })
    },
    onData(stream, session, cb) {
      simpleParser(stream)
        .then((mail) => {
          messages.push({
            id: messages.length + 1,
            receivedAt: new Date().toISOString(),
            from: addrs(mail.from),
            to: addrs(mail.to),
            cc: addrs(mail.cc),
            subject: mail.subject || '',
            text: mail.text || '',
          })
          cb()
        })
        .catch(cb)
    },
  })

  const web = createServer((req, res) => {
    if (req.url === '/messages.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(messages))
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderInbox(messages))
    }
  })

  await new Promise((resolve, reject) => {
    smtp.server.once('error', reject)
    smtp.listen(smtpPort, host, resolve)
  })
  await new Promise((resolve, reject) => {
    web.once('error', reject)
    web.listen(httpPort, host, resolve)
  })

  return {
    messages,
    smtpPort: smtp.server.address().port,
    httpPort: web.address().port,
    async close() {
      await new Promise((r) => smtp.close(r))
      await new Promise((r) => web.close(r))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadEnv } = await import('../scripts/lib/env.mjs')
  const env = loadEnv()
  const c = await createCatcher({ smtpPort: Number(env.SMTP_PORT), httpPort: 8025 })
  console.log(`SMTP catcher on localhost:${c.smtpPort}; inbox at http://localhost:${c.httpPort}`)
}
