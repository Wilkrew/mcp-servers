// A small client for SL's open APIs (no key needed): SL Transport for stops
// and departures, SL Deviations for disruptions, SL Journey Planner v2 for
// trips. Responses are cached so the server stays within fair use: the stop
// and stop point lists for a day, disruptions for a minute (SL asks for at most
// one request a minute), trips for 30 s and departures for 20 s.

export const TRANSPORT = 'https://transport.integration.sl.se/v1'
export const DEVIATIONS = 'https://deviations.integration.sl.se/v1'
export const JOURNEY = 'https://journeyplanner.integration.sl.se/v2'
export const MODES = ['BUS', 'METRO', 'TRAM', 'TRAIN', 'SHIP', 'FERRY', 'TAXI'] as const
export type Mode = (typeof MODES)[number]

/** Modes the journey planner can leave out. TRAIN is pendeltåg; TRAM also covers local trains. */
export const TRIP_MODES = ['BUS', 'METRO', 'TRAM', 'TRAIN', 'SHIP'] as const
export type TripMode = (typeof TRIP_MODES)[number]
// Journey planner mode codes. BUS also covers on-demand (10) and närtrafik (19);
// 14 is national trains, which no option leaves out.
const MOT: Record<TripMode, number[]> = { TRAIN: [0], METRO: [2], TRAM: [4], BUS: [5, 10, 19], SHIP: [9] }
const ALL_MOT = [0, 2, 4, 5, 9, 10, 14, 19]

/** Product classes of the modes left out; a leg's product.class uses the same codes. */
export const avoidedClasses = (exclude: readonly TripMode[]) => new Set(exclude.flatMap(m => MOT[m]))

/** The journey planner's 16-digit id for a Transport site id, e.g. 9117 → 9091001000009117. */
export const globalId = (siteId: number) => `9091001${String(siteId).padStart(9, '0')}`

export type Place = { site: number } | { lat: number, lon: number }

export type TripQuery = {
  from: Place
  to: Place
  trips?: number
  date?: string
  time?: string
  arriveBy?: boolean
  maxChanges?: number
  routeType?: 'leasttime' | 'leastinterchange' | 'leastwalking'
  exclude?: readonly TripMode[]
}

export type JpPoint = {
  id?: string
  name?: string
  disassembledName?: string
  type?: string
  /** [lat, lon] */
  coord?: number[]
  parent?: { id?: string, name?: string, disassembledName?: string, type?: string }
  properties?: Record<string, unknown>
  departureTimePlanned?: string
  departureTimeEstimated?: string
  arrivalTimePlanned?: string
  arrivalTimeEstimated?: string
}

type JpInfoText = { title?: string, subtitle?: string, urlText?: string }

export type JpLeg = {
  duration?: number
  distance?: number
  origin: JpPoint
  destination: JpPoint
  transportation?: {
    name?: string
    number?: string
    disassembledName?: string
    product?: { class?: number, name?: string }
    destination?: { name?: string }
  }
  stopSequence?: unknown[]
  realtimeStatus?: string[]
  isRealtimeControlled?: boolean
  infos?: (JpInfoText & { infoLinks?: JpInfoText[] })[]
}

export type JpJourney = { tripDuration?: number, tripRtDuration?: number, interchanges?: number, legs: JpLeg[] }

export type TripsResponse = {
  journeys?: JpJourney[]
  systemMessages?: { type?: string, code?: number, text?: string }[]
}

function setPlace(q: URLSearchParams, role: 'origin' | 'destination', p: Place) {
  if ('site' in p) {
    q.set(`type_${role}`, 'any')
    q.set(`name_${role}`, globalId(p.site))
  } else {
    // The planner wants longitude first.
    q.set(`type_${role}`, 'coord')
    q.set(`name_${role}`, `${p.lon}:${p.lat}:WGS84[dd.ddddd]`)
  }
}

export type Site = { id: number, name: string, note?: string, abbreviation?: string, lat: number, lon: number, stop_areas?: number[] }

/** A platform, bus stop letter or quay within a stop area. */
export type StopPoint = {
  id: number
  name: string
  designation?: string | null
  type?: string
  has_entrance?: boolean
  lat: number
  lon: number
  stop_area: { id: number, name: string, type?: string }
  valid?: { from?: string, to?: string }
}

export type Departure = {
  destination: string
  direction: string
  direction_code: number
  state: string
  display: string
  scheduled: string
  expected?: string
  stop_area: { id: number, name: string, type: string }
  stop_point: { id: number, name: string, designation?: string }
  line: { id: number, designation: string, transport_mode: Mode, group_of_lines?: string }
  deviations?: { importance_level: number, consequence: string, message: string }[]
}

export type DeparturesResponse = {
  departures: Departure[]
  stop_deviations: { importance: number, consequence: string, message: string }[]
}

export type Deviation = {
  deviation_case_id: number
  publish: { from: string, upto?: string }
  priority: { importance_level: number, influence_level: number, urgency_level: number }
  message_variants: { header: string, details: string, scope_alias?: string, weblink?: string, language: string }[]
  scope: {
    stop_areas?: { id: number, name: string, type: string }[]
    lines?: { id: number, designation: string, transport_mode: Mode, name?: string, group_of_lines?: string }[]
  }
}

type Fetch = typeof fetch

const DAY = 24 * 60 * 60 * 1000

export class SlApi {
  private cache = new Map<string, { at: number, value: unknown }>()
  private fetcher: Fetch
  private now: () => number

  constructor(opts: { fetch?: Fetch, now?: () => number } = {}) {
    this.fetcher = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
  }

  private async get<T>(url: string, ttl: number): Promise<T> {
    const hit = this.cache.get(url)
    if (hit && this.now() - hit.at < ttl) return hit.value as T
    const res = await this.fetcher(url, {
      headers: { accept: 'application/json', 'user-agent': 'sl-departures-mcp/0.2' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`SL answered ${res.status} for ${new URL(url).pathname}`)
    const value = (await res.json()) as T
    this.cache.set(url, { at: this.now(), value })
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  async sites(): Promise<Site[]> {
    // expand=true adds each site's stop area ids, which link it to its stop points.
    type Raw = Omit<Site, 'stop_areas'> & { stop_areas?: (number | { id: number })[] }
    const raw = await this.get<Raw[]>(`${TRANSPORT}/sites?expand=true`, DAY)
    return raw.map(({ id, name, note, abbreviation, lat, lon, stop_areas }) => ({
      id, name, note, abbreviation, lat, lon,
      stop_areas: (stop_areas ?? []).map(a => (typeof a === 'number' ? a : a.id))
    }))
  }

  stopPoints(): Promise<StopPoint[]> {
    return this.get(`${TRANSPORT}/stop-points`, DAY)
  }

  departures(siteId: number, f: { transport?: Mode, line?: string, direction?: 1 | 2, minutes?: number } = {}): Promise<DeparturesResponse> {
    const q = new URLSearchParams()
    if (f.transport) q.set('transport', f.transport)
    if (f.line) q.set('line', f.line)
    if (f.direction) q.set('direction', String(f.direction))
    if (f.minutes) q.set('forecast', String(f.minutes))
    const qs = q.size ? `?${q}` : ''
    return this.get(`${TRANSPORT}/sites/${siteId}/departures${qs}`, 20_000)
  }

  deviations(f: { sites?: number[], lines?: string[], modes?: Mode[], future?: boolean } = {}): Promise<Deviation[]> {
    const q = new URLSearchParams()
    q.set('future', String(Boolean(f.future)))
    for (const s of f.sites ?? []) q.append('site', String(s))
    for (const l of f.lines ?? []) q.append('line', l)
    for (const m of f.modes ?? []) q.append('transport_mode', m)
    return this.get(`${DEVIATIONS}/messages?${q}`, 60_000)
  }

  trips(t: TripQuery): Promise<TripsResponse> {
    const q = new URLSearchParams()
    setPlace(q, 'origin', t.from)
    setPlace(q, 'destination', t.to)
    q.set('calc_number_of_trips', String(t.trips ?? 3))
    // Only trips after the asked time (or before it, when arriving by), and no
    // coordinates along each leg, which would multiply the response size.
    q.set('calc_one_direction', 'true')
    q.set('gen_c', 'false')
    if (t.date) q.set('itd_date', t.date.replaceAll('-', ''))
    if (t.time) q.set('itd_time', t.time.replace(':', ''))
    if (t.arriveBy) q.set('itd_trip_date_time_dep_arr', 'arr')
    if (t.maxChanges !== undefined) q.set('max_changes', String(t.maxChanges))
    if (t.routeType) q.set('route_type', t.routeType)
    // The planner ignores incl_mot_N=false unless the modes to keep are sent as
    // true too (checked live, 17 Nov 2026), so leaving modes out sends all of them.
    if (t.exclude?.length) {
      const off = avoidedClasses(t.exclude)
      for (const n of ALL_MOT) q.set(`incl_mot_${n}`, String(!off.has(n)))
    }
    return this.get(`${JOURNEY}/trips?${q}`, 30_000)
  }
}
