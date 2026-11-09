// Tests against trimmed real responses from SL (6 Nov 2026), served by a fake
// fetch. They never call SL.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SlApi } from '../src/api.ts'
import { createServer } from '../src/server.ts'
import { findStops, nearby } from '../src/stops.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const sites = JSON.parse(fixture('sites.json'))

const requests: string[] = []
let clock = 0
const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input))
  requests.push(url.href)
  let body: string
  if (url.pathname === '/v1/sites') body = fixture('sites.json')
  else if (url.pathname === '/v1/sites/9001/departures') body = fixture('departures-9001.json')
  else if (url.pathname === '/v1/messages') body = fixture('deviations-9001.json')
  else return new Response('not found', { status: 404 })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const api = new SlApi({ fetch: fakeFetch, now: () => clock })
const [a, b] = InMemoryTransport.createLinkedPair()
await createServer(api).connect(a)
const client = new Client({ name: 'test', version: '0' })
await client.connect(b)

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = (res.content as { text: string }[])[0].text
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) }
}

test('stop search handles missing å, ä, ö and prefers the plain stop', () => {
  assert.equal(findStops(sites, 'T-Centralen')[0].id, 9001)
  assert.equal(findStops(sites, 'hotorget')[0].name, 'Hötorget')
  const slussen = findStops(sites, 'slussen')
  assert.equal(slussen[0].id, 9192)
  assert.equal(slussen[1].note, 'ersättningstrafik')
  assert.equal(findStops(sites, 'TCE')[0].id, 9001)
  assert.deepEqual(findStops(sites, 'nowhere at all'), [])
})

test('nearby stops are sorted by distance', () => {
  const hits = nearby(sites, { lat: 59.33138, lon: 18.06043 }, 300, 5)
  assert.equal(hits[0].site.id, 9001)
  assert.ok(hits.every((h, i) => i === 0 || h.distance >= hits[i - 1].distance))
})

test('every tool is read-only', async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(t => t.name).sort(), ['find_stop', 'get_departures', 'get_disruptions', 'nearby_stops'])
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true)
})

test('departures by stop name, shaped and with filters passed to SL', async () => {
  const { data } = await call('get_departures', { stop: 'T-Centralen', mode: 'METRO', line: '19', direction: 2, minutes: 30, limit: 20 })
  assert.equal(data.stop.site_id, 9001)
  const url = new URL(requests.find(r => r.includes('/sites/9001/departures'))!)
  assert.equal(url.searchParams.get('transport'), 'METRO')
  assert.equal(url.searchParams.get('line'), '19')
  assert.equal(url.searchParams.get('direction'), '2')
  assert.equal(url.searchParams.get('forecast'), '30')

  const cancelled = data.departures.find((d: { cancelled: boolean }) => d.cancelled)
  assert.deepEqual(cancelled, {
    line: '19', mode: 'METRO', destination: 'Hagsätra', platform: '4', departs: '17:31',
    expected: '17:31', scheduled: '17:31', delay_min: null, cancelled: true, notes: ['Inställd']
  })
  const late = data.departures.find((d: { destination: string }) => d.destination === 'Skarpnäck')
  assert.equal(late.delay_min, 2)
  assert.equal(late.expected, '17:31')
  assert.equal(late.scheduled, '17:29')
})

test('an ambiguous name says which stop it used and lists the rest', async () => {
  const res = await call('find_stop', { query: 'kungstradgarden' })
  assert.equal(res.data.length, 2)
  const unknown = await call('get_departures', { stop: 'Atlantis' })
  assert.equal(unknown.isError, true)
  const missing = await call('get_departures', { stop: '1234567' })
  assert.match(missing.text, /No stop with site id/)
})

test('disruptions for a stop, with fair-use caching', async () => {
  const before = requests.filter(r => r.includes('/v1/messages')).length
  const first = await call('get_disruptions', { stop: '9001' })
  assert.equal(first.data.count, 1)
  assert.deepEqual(first.data.notices[0].lines, ['17 (METRO)'])
  assert.equal(first.data.notices[0].language, 'sv')
  const url = new URL(requests.at(-1)!)
  assert.deepEqual(url.searchParams.getAll('site'), ['9001'])
  assert.equal(url.searchParams.get('future'), 'false')

  await call('get_disruptions', { stop: '9001' })
  assert.equal(requests.filter(r => r.includes('/v1/messages')).length, before + 1, 'cached within a minute')
  clock += 61_000
  await call('get_disruptions', { stop: '9001' })
  assert.equal(requests.filter(r => r.includes('/v1/messages')).length, before + 2, 'fetched again after a minute')
})

test('the stop list is fetched once and reused', () => {
  assert.equal(requests.filter(r => r.includes('/v1/sites?')).length, 1)
})

test('SL errors become tool errors, not crashes', async () => {
  const broken = new SlApi({ fetch: (async () => new Response('down', { status: 503 })) as typeof fetch })
  const [x, y] = InMemoryTransport.createLinkedPair()
  await createServer(broken).connect(x)
  const c = new Client({ name: 'broken', version: '0' })
  await c.connect(y)
  const res = await c.callTool({ name: 'find_stop', arguments: { query: 'Slussen' } })
  assert.equal(res.isError, true)
  assert.match((res.content as { text: string }[])[0].text, /503/)
})
