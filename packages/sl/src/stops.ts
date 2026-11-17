import type { Site } from './api.ts'

export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Best name matches first: exact, then starts with, then every word found. */
export function findStops(sites: Site[], query: string, limit = 8): Site[] {
  const q = fold(query)
  if (!q) return []
  const words = q.split(' ')
  const scored: { site: Site, score: number }[] = []
  for (const site of sites) {
    const name = fold(site.name)
    const full = fold(`${site.name} ${site.note ?? ''}`)
    let score = 0
    if (name === q) score = 100
    else if (site.abbreviation && fold(site.abbreviation) === q) score = 90
    else if (name.startsWith(q)) score = 70
    else if (words.every(w => full.includes(w))) score = 40
    if (!score) continue
    // Prefer the plain stop over replacement-traffic and other noted variants.
    if (site.note) score -= 5
    scored.push({ site, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.site.name.length - b.site.name.length || a.site.id - b.site.id)
    .slice(0, limit)
    .map(s => s.site)
}

export function distanceM(a: { lat: number, lon: number }, b: { lat: number, lon: number }): number {
  const R = 6_371_000
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** Eight-point compass direction from a to b, e.g. "NE". */
export function compass(a: { lat: number, lon: number }, b: { lat: number, lon: number }): (typeof COMPASS)[number] {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLon = rad(b.lon - a.lon)
  const y = Math.sin(dLon) * Math.cos(rad(b.lat))
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon)
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  return COMPASS[Math.round(deg / 45) % 8]
}

export function nearby(sites: Site[], at: { lat: number, lon: number }, radiusM: number, limit: number) {
  return sites
    .map(site => ({ site, distance: distanceM(at, site) }))
    .filter(x => x.distance <= radiusM)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
}
