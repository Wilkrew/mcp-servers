// A small client for SL's open APIs (no key needed): SL Transport for stops
// and departures, SL Deviations for disruptions. Responses are cached so the
// server stays within fair use: the stop list for a day, disruptions for a
// minute (SL asks for at most one request a minute), departures for 20 s.

export const TRANSPORT = 'https://transport.integration.sl.se/v1'
export const DEVIATIONS = 'https://deviations.integration.sl.se/v1'
export const MODES = ['BUS', 'METRO', 'TRAM', 'TRAIN', 'SHIP', 'FERRY', 'TAXI'] as const
export type Mode = (typeof MODES)[number]

export type Site = { id: number, name: string, note?: string, abbreviation?: string, lat: number, lon: number }

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
      headers: { accept: 'application/json', 'user-agent': 'sl-departures-mcp/0.1' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`SL answered ${res.status} for ${new URL(url).pathname}`)
    const value = (await res.json()) as T
    this.cache.set(url, { at: this.now(), value })
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  async sites(): Promise<Site[]> {
    const raw = await this.get<Site[]>(`${TRANSPORT}/sites?expand=false`, DAY)
    return raw.map(({ id, name, note, abbreviation, lat, lon }) => ({ id, name, note, abbreviation, lat, lon }))
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
}
