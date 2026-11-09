import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer, index } from '../src/server.ts'
import { handleMcp } from '../src/handler.ts'
import { site } from '../src/data.ts'

const [a, b] = InMemoryTransport.createLinkedPair()
await createServer().connect(a)
const client = new Client({ name: 'test', version: '0' })
await client.connect(b)

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = (res.content as { text: string }[])[0].text
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) }
}

test('the data holds public content only', () => {
  const all = JSON.stringify(site)
  assert.doesNotMatch(all, /(\+46|\b0)\s?7\d[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/, 'no phone numbers')
  assert.doesNotMatch(all, /seo-delivery/, 'the unlisted delivery case stays out')
  assert.doesNotMatch(JSON.stringify(site.cases.delivery), /\bSEO\b/, 'the public delivery case is the discreet one')
  assert.doesNotMatch(all, /"birthday"/)
  assert.equal(site.profile.contact.email, 'filip@heinel.dev')
})

test('every tool is read-only', async () => {
  const { tools } = await client.listTools()
  assert.equal(tools.length, 8)
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name)
})

test('about and experience', async () => {
  const about = await call('about')
  assert.equal(about.data.name, 'Filip Heinel')
  const career = await call('list_experience', { lane: 'career' })
  assert.ok(career.data.length >= 3)
  assert.ok(career.data.every((r: { lane: string }) => r.lane === 'career'))
  const role = await call('get_experience', { id: career.data[0].id })
  assert.equal(role.data.company, career.data[0].company)
  const bad = await call('get_experience', { id: 'nope' })
  assert.equal(bad.isError, true)
})

test('work links to its case studies', async () => {
  const { data } = await call('list_work')
  const withCase = data.filter((w: { case: string | null }) => w.case)
  assert.ok(withCase.some((w: { case: string }) => w.case === 'suntarbetsliv'))
  const c = await call('get_case', { case: 'suntarbetsliv' })
  assert.match(c.data.title, /Friskfaktorlabbet/)
})

test('search finds the right piece and links to it', async () => {
  const { data } = await call('search', { query: 'chatbot vector search' })
  assert.ok(data.results.length > 0)
  assert.match(data.results[0].id, /suntarbetsliv/)
  assert.match(data.results[0].url, /^https:\/\/heinel\.dev/)
  const sv = await call('search', { query: 'affarsvarlden' })
  assert.ok(sv.data.results.some((r: { id: string }) => r.id.includes('affarsvarlden')), 'matches without å, ä, ö')
  const none = await call('search', { query: 'xylophone quantum' })
  assert.deepEqual(none.data.results, [])
  assert.ok(index.size > 50)
})

test('resource and prompt', async () => {
  const res = await client.readResource({ uri: 'heinel://site.json' })
  const body = JSON.parse((res.contents[0] as { text: string }).text)
  assert.equal(body.profile.name, 'Filip Heinel')
  const prompt = await client.getPrompt({ name: 'role_fit', arguments: { brief: 'Full-stack developer with Next.js and TypeScript.' } })
  const text = (prompt.messages[0].content as { text: string }).text
  assert.match(text, /<brief>\nFull-stack developer/)
})

test('stateless HTTP handler', async () => {
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } }
  }
  const res = await handleMcp(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(init)
  }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.result.serverInfo.name, 'heinel-dev')
  const get = await handleMcp(new Request('http://localhost/mcp'))
  assert.equal(get.status, 405)
})

test('the stdio entry point starts', async () => {
  const stdio = new Client({ name: 'stdio-test', version: '0' })
  await stdio.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', new URL('../src/stdio.ts', import.meta.url).pathname],
    stderr: 'ignore'
  }))
  const { tools } = await stdio.listTools()
  assert.ok(tools.some(t => t.name === 'search'))
  await stdio.close()
})
