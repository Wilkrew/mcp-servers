// Tests against trimmed real responses from SL (6 and 17 Nov 2026), served by
// a fake fetch. They never call SL.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SlApi } from '../src/api.ts'
import { createServer, shapeLeg } from '../src/server.ts'
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
  else if (url.pathname === '/v1/sites/9117/departures') body = fixture('departures-9117.json')
  else if (/^\/v1\/sites\/\d+\/departures$/.test(url.pathname)) body = JSON.stringify({ departures: [], stop_deviations: [] })
  else if (url.pathname === '/v1/messages') body = fixture('deviations-9001.json')
  else if (url.pathname === '/v1/stop-points') {
    // One made-up stop point whose validity has ended, to check it is left out.
    const points = JSON.parse(fixture('stop-points.json'))
    body = JSON.stringify([...points, { ...points.at(-2), id: 99001, designation: 'X', valid: { from: '2020-01-01T00:00:00', to: '2025-06-01T00:00:00' } }])
  }
  // The planner answers 200 with only systemMessages when it finds nothing.
  else if (url.pathname === '/v2/trips' && url.searchParams.get('name_destination') === '9091001000009001') {
    body = JSON.stringify({ systemMessages: [{ type: 'error', code: -8010, text: '' }, { type: 'error', code: -4000, text: 'no connection found' }] })
  } else if (url.pathname === '/v2/trips' && url.searchParams.get('type_origin') === 'coord') body = fixture('trips-coord-9302.json')
  else if (url.pathname === '/v2/trips') body = fixture('trips-9117-9192.json')
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

test('the server names itself, with a title and icons on heinel.dev', () => {
  const info = client.getServerVersion()
  assert.equal(info?.name, 'sl-departures')
  assert.equal(info?.title, 'SL departures')
  assert.ok((info?.icons ?? []).length > 0)
  assert.ok(info?.icons?.every(i => i.src.startsWith('https://heinel.dev/mcp-icons/')))
})

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
  assert.deepEqual(tools.map(t => t.name).sort(), ['find_stop', 'get_departures', 'get_disruptions', 'nearby_stops', 'plan_trip', 'stop_layout'])
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
  assert.equal(res.data.results.length, 2)
  assert.match(res.data.source, /Trafiklab\.se/)
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

const lastTripUrl = () => new URL(requests.findLast(r => r.includes('/v2/trips'))!)
const SIGNAL_FAULT = 'Restiden förbi Gullmarsplan kan bli förlängd med upp till 15 minuter pga signalfel. Förseningar och inställda avgångar kan förekomma.'

test('plan_trip sends stop names as journey planner ids, with the asked time and options', async () => {
  const { data } = await call('plan_trip', {
    from: 'Odenplan', to: 'slussen', time: '07:45', date: '2026-11-17', arrive_by: true,
    trips: 1, max_changes: 1, prefer: 'fewest_changes', avoid: ['BUS', 'TRAIN']
  })
  const q = lastTripUrl().searchParams
  assert.equal(lastTripUrl().host, 'journeyplanner.integration.sl.se')
  assert.equal(q.get('type_origin'), 'any')
  assert.equal(q.get('name_origin'), '9091001000009117')
  assert.equal(q.get('name_destination'), '9091001000009192')
  assert.equal(q.get('itd_date'), '20261117')
  assert.equal(q.get('itd_time'), '0745')
  assert.equal(q.get('itd_trip_date_time_dep_arr'), 'arr')
  assert.equal(q.get('calc_number_of_trips'), '1')
  assert.equal(q.get('max_changes'), '1')
  assert.equal(q.get('route_type'), 'leastinterchange')
  assert.equal(q.get('gen_c'), 'false')
  assert.equal(q.get('calc_one_direction'), 'true')
  // SL only honours false when the modes to keep are sent as true.
  const mot = Object.fromEntries([0, 2, 4, 5, 9, 10, 14, 19].map(n => [n, q.get(`incl_mot_${n}`)]))
  assert.deepEqual(mot, { 0: 'false', 2: 'true', 4: 'true', 5: 'false', 9: 'true', 10: 'false', 14: 'true', 19: 'false' })
  assert.equal(data.from.site_id, 9117)
  assert.equal(data.asked, 'arrive by 07:45 on 2026-11-17')
  assert.equal(data.trips.length, 1, 'never more trips than asked for')

  await call('plan_trip', { from: 'Odenplan', to: 'Slussen' })
  assert.equal(lastTripUrl().searchParams.get('incl_mot_2'), null, 'no mode parameters unless something is avoided')
})

test('plan_trip drops trips SL returns on an avoided mode', async () => {
  // Both recorded trips are metro only.
  const res = await call('plan_trip', { from: 'Odenplan', to: 'Slussen', avoid: ['METRO'] })
  assert.equal(res.isError, true)
  assert.match(res.text, /that avoids METRO/)
})

test('plan_trip shapes legs in Stockholm time, with delays, platforms, positions and notices', async () => {
  const { data } = await call('plan_trip', { from: '9117', to: '9192' })
  assert.match(data.source, /Trafiklab\.se/)
  assert.deepEqual(data.trips[0], {
    departs: '12:18', arrives: '12:25', duration_min: 7, changes: 0, all_live: true, cancelled: false,
    legs: [{
      type: 'ride', mode: 'METRO', mode_name: 'Tunnelbana', line: '17', toward: 'Skarpnäck',
      from: 'Odenplan', platform: '2', platform_position: { lat: 59.342768, lon: 18.048708 },
      departs: '12:18', delay_min: 3, to: 'Slussen', arrives: '12:25', stops: 5,
      live: true, cancelled: false, notes: [SIGNAL_FAULT]
    }]
  })
  assert.equal(data.trips[1].legs[0].line, '19')
  assert.equal(data.trips[1].legs[0].delay_min, 2)
})

test('plan_trip takes positions as "lat,lon" and shows street walks and changes inside stations', async () => {
  const { data } = await call('plan_trip', { from: '59.3326, 18.0649', to: 'Kista' })
  const q = lastTripUrl().searchParams
  assert.equal(q.get('type_origin'), 'coord')
  assert.equal(q.get('name_origin'), '18.0649:59.3326:WGS84[dd.ddddd]', 'longitude first for SL')
  assert.equal(q.get('name_destination'), '9091001000009302')
  assert.equal(q.get('itd_time'), null, 'no time means leave now')
  assert.deepEqual(data.from, { lat: 59.3326, lon: 18.0649 })

  const [trip] = data.trips
  assert.deepEqual([trip.departs, trip.arrives, trip.duration_min, trip.changes, trip.all_live], ['12:22', '12:43', 21, 0, true])
  assert.deepEqual(trip.legs[0], { type: 'walk', from: 'Sergelgången 31', to: 'T-Centralen', minutes: 2, distance_m: 116, in_station: false })
  assert.deepEqual(trip.legs[1], { type: 'walk', from: 'T-Centralen', to: 'T-Centralen', minutes: 3, distance_m: null, in_station: true })
  const metro = trip.legs[2]
  assert.deepEqual(
    [metro.line, metro.toward, metro.platform, metro.departs, metro.arrives, metro.stops, metro.delay_min],
    ['11', 'Akalla', '5', '12:27', '12:43', 8, 0]
  )

  const far = await call('plan_trip', { from: '57.7,11.97', to: 'Slussen' })
  assert.equal(far.isError, true)
  assert.match(far.text, /outside SL's area/)
})

test('a leg SL marks as cancelled, or without real-time data, says so', () => {
  const leg = JSON.parse(fixture('trips-9117-9192.json')).journeys[0].legs[0]
  const cancelled = shapeLeg({ ...leg, realtimeStatus: ['MONITORED', 'TRIP_CANCELLED'] })
  assert.equal(cancelled.type === 'ride' && cancelled.cancelled, true)
  assert.equal(cancelled.type === 'ride' && cancelled.delay_min, null)
  const timetable = shapeLeg({ ...leg, realtimeStatus: undefined, isRealtimeControlled: false, origin: { ...leg.origin, departureTimeEstimated: undefined } })
  assert.deepEqual(timetable.type === 'ride' && [timetable.live, timetable.delay_min, timetable.departs], [false, 0, '12:16'])
})

test('plan_trip explains when SL finds nothing, and needs a time to arrive by', async () => {
  const none = await call('plan_trip', { from: 'Odenplan', to: 'T-Centralen' })
  assert.equal(none.isError, true)
  assert.match(none.text, /no connection found/)
  assert.doesNotMatch(none.text, /-8010/)

  const noTime = await call('plan_trip', { from: 'Odenplan', to: 'Slussen', arrive_by: true })
  assert.equal(noTime.isError, true)
  assert.match(noTime.text, /time to arrive by/)
})

test('stop_layout lists a stop\'s platforms and letters with positions and current lines', async () => {
  const { data } = await call('stop_layout', { stop: 'Odenplan' })
  assert.equal(data.stop.site_id, 9117)
  assert.match(data.source, /Trafiklab\.se/)
  assert.deepEqual(
    data.points.map((p: { area: string, area_type: string, designation: string }) => `${p.area} ${p.area_type} ${p.designation}`),
    [
      ...['A', 'B', 'C', 'F', 'G', 'H', 'I', 'J', 'K', 'M'].map(l => `Odenplan BUSTERM ${l}`),
      'Odenplan METROSTN 1', 'Odenplan METROSTN 2', 'Stockholm Odenplan RAILWSTN 1', 'Stockholm Odenplan RAILWSTN 2'
    ],
    'other stops, retired OLD positions and expired points are left out'
  )
  const at = (area: string, designation: string) =>
    data.points.find((p: { area_type: string, designation: string }) => p.area_type === area && p.designation === designation)

  const h = at('BUSTERM', 'H')
  assert.deepEqual(h.lines, [{ line: '53', mode: 'BUS', toward: 'Henriksdalsberget' }])
  assert.equal(h.next_departure, '12:16')
  assert.equal(h.type, 'BUSSTOP')
  assert.equal(h.entrance, false)
  assert.equal(h.from_centre.direction, 'SW')
  assert.ok(h.from_centre.distance_m > 30 && h.from_centre.distance_m < 60)

  const metro = at('METROSTN', '2')
  assert.deepEqual(metro.lines.map((l: { line: string, toward: string }) => `${l.line} ${l.toward}`), ['17 Skarpnäck', '19 Hagsätra'])
  assert.equal(metro.next_departure, '12:18')
  assert.equal(metro.entrance, true)

  assert.deepEqual(at('RAILWSTN', '1').lines.map((l: { line: string }) => l.line), ['43', '41'])
  assert.equal(at('RAILWSTN', '1').from_centre.direction, 'W')
  const m = at('BUSTERM', 'M')
  assert.deepEqual([m.lines, m.next_departure, m.from_centre.direction], [[], null, 'W'])
})

test('stop_layout uses the expanded stop list and fetches stop points once a day', async () => {
  await call('stop_layout', { stop: '9117' })
  assert.ok(requests.some(r => r.includes('/v1/sites?expand=true')))
  assert.equal(requests.filter(r => r.includes('/v1/stop-points')).length, 1)
  const none = await call('stop_layout', { stop: 'Slussen' })
  assert.equal(none.isError, true)
  assert.match(none.text, /no platforms or stop letters for Slussen/)
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
