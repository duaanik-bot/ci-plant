#!/usr/bin/env node

import fs from 'node:fs'

function readEnvFile(path) {
  if (!fs.existsSync(path)) return {}
  const out = {}
  const text = fs.readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    value = value.replace(/^['"]|['"]$/g, '')
    out[key] = value
  }
  return out
}

const envFromFiles = {
  ...readEnvFile('.env'),
  ...readEnvFile('.env.local'),
}

function envValue(key) {
  return Object.prototype.hasOwnProperty.call(process.env, key)
    ? process.env[key] || ''
    : envFromFiles[key] || ''
}

const databaseUrl = envValue('DATABASE_URL')
const directUrl = envValue('DIRECT_URL')

function hostnameOf(value) {
  if (!value) return ''
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

const databaseHost = hostnameOf(databaseUrl)
const directHost = hostnameOf(directUrl)
const hosts = [databaseHost, directHost].filter(Boolean)

if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Refusing to run database-affecting deployment steps.')
  process.exit(1)
}

if (hosts.some((host) => host.includes('neon.tech'))) {
  console.error('Refusing to run deployment database steps against Neon. Staging/production must use Supabase.')
  console.error(`Detected database host: ${databaseHost || 'unset'}`)
  if (directHost) console.error(`Detected direct host: ${directHost}`)
  process.exit(1)
}

const supabaseLike =
  hosts.some((host) => host.includes('supabase.co')) ||
  hosts.some((host) => host.includes('pooler.supabase.com')) ||
  hosts.some((host) => host.includes('supabase'))

if (!supabaseLike) {
  console.warn('DATABASE_URL is not recognized as Supabase. Continuing only because it is not Neon.')
  console.warn(`Detected database host: ${databaseHost || 'unset'}`)
}
