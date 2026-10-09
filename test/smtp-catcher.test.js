import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import nodemailer from 'nodemailer'
import { createCatcher } from '../mock-services/smtp-catcher.mjs'

describe('smtp catcher', () => {
  let catcher
  after(async () => catcher?.close())

  it('accepts a message and shows it in the HTML inbox', async () => {
    catcher = await createCatcher({ smtpPort: 0, httpPort: 0 })
    const transport = nodemailer.createTransport({
      host: '127.0.0.1',
      port: catcher.smtpPort,
      secure: false,
      ignoreTLS: true,
      auth: { user: 'demo', pass: 'demo' },
    })
    await transport.sendMail({
      from: 'qa-team@example.com',
      to: 'agent.alpha@example.com',
      cc: 'qa-lead@example.com',
      subject: 'Quality feedback - Agent Alpha <test>',
      text: 'Dear Agent Alpha,\nPERFECT',
    })
    assert.equal(catcher.messages.length, 1)
    assert.equal(catcher.messages[0].to, 'agent.alpha@example.com')

    const html = await (await fetch(`http://127.0.0.1:${catcher.httpPort}/`)).text()
    assert.match(html, /Quality feedback - Agent Alpha &lt;test&gt;/)
    assert.match(html, /PERFECT/)
    const list = await (await fetch(`http://127.0.0.1:${catcher.httpPort}/messages.json`)).json()
    assert.equal(list.length, 1)
  })
})
