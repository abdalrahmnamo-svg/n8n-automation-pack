import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** n8n version this repo was verified against (requires Node >= 24). */
export const N8N_VERSION = '2.42.6'

export const DEFAULTS = {
  WEBHOOK_SHARED_SECRET: 'change-me',
  SMTP_PORT: '2525',
  MOCK_API_PORT: '4010',
  N8N_USER_FOLDER: './.n8n',
  N8N_BASE_URL: 'http://localhost:5678',
}

/** Load .env (if present) without overriding real environment variables, then apply defaults. */
export function loadEnv() {
  const file = join(root, '.env')
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file)
    } catch {
      // ignore unreadable .env, defaults still apply
    }
  }
  const out = {}
  for (const [k, v] of Object.entries(DEFAULTS)) out[k] = process.env[k] || v
  return out
}

export const repoRoot = root
