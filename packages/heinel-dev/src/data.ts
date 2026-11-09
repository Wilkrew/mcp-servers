import site from '../data/site.json' with { type: 'json' }
import type { Chunk } from './search.ts'

export type Site = typeof site
export { site }

type Named = { name: string, line: string }
type Role = {
  id: string, company: string, title: string, period: string, lane: string, summary: string, tags: string[]
  parts?: { title: string, period?: string, summary: string }[]
  quote?: { text: string, name: string, role: string, source: string }
}

const text = (...parts: (string | undefined | null | false)[]) => parts.filter(Boolean).join(' ')
const lines = (list?: Named[]) => (list ?? []).map(x => `${x.name}: ${x.line}`).join(' ')

/** Splits the site into searchable pieces, each with a link back. */
export function chunks(s: Site = site): Chunk[] {
  const out: Chunk[] = []
  const home = s.source.site
  const p = s.profile
  out.push({ id: 'profile', title: `${p.name}, ${p.tagline}`, text: text(p.headline, ...p.facts.map(f => `${f.label}: ${f.value}.`)), url: home })
  for (const n of p.now) out.push({ id: `now:${n.label.toLowerCase()}`, title: `Now: ${n.label}`, text: n.text, url: `${home}/#now` })

  for (const r of s.experience as Role[]) {
    const parts = (r.parts ?? []).map(x => text(`${x.title}${x.period ? ` (${x.period})` : ''}:`, x.summary)).join(' ')
    out.push({
      id: `experience:${r.id}`,
      title: `${r.title}, ${r.company} (${r.period})`,
      text: text(r.summary, parts, `Skills: ${r.tags.join(', ')}.`, r.quote && `"${r.quote.text}" (${r.quote.name}, ${r.quote.role})`),
      url: `${home}/#${r.lane === 'earlier' ? 'earlier' : 'experience'}`
    })
  }
  for (const w of s.work) {
    out.push({
      id: `work:${w.id}`,
      title: `${w.title} (${w.kind}${w.period ? `, ${w.period}` : ''})`,
      text: text(w.summary, (w.highlights ?? []).join(' '), w.result, `Skills: ${w.tags.join(', ')}.`),
      url: w.url ?? `${home}/#work`
    })
  }
  for (const [id, c] of Object.entries(s.cases) as [string, Record<string, any>][]) {
    const base = { url: c.url as string }
    out.push({ ...base, id: `case:${id}`, title: c.title, text: text(c.oneLiner, c.problem, c.premise, c.role) })
    const lists: [string, string][] = [
      ['constraints', (c.constraints ?? []).join(' ')],
      ['decisions', lines(c.decisions)],
      ['agentic', lines(c.agentic)],
      ['skills', lines(c.skills)],
      ['value', lines(c.value)],
      ['steps', lines(c.steps)],
      ['rules', lines(c.rules)],
      ['engineering', lines(c.engineering)],
      ['result', text(c.result, c.differently, c.origin, c.boundary)]
    ]
    for (const [section, body] of lists) {
      if (body) out.push({ ...base, id: `case:${id}#${section}`, title: `${c.title}: ${section}`, text: body })
    }
  }
  for (const g of s.skills.groups) out.push({ id: `skills:${g.id}`, title: `Stack: ${g.label}`, text: g.items.join(', '), url: `${home}/#stack` })
  out.push({ id: 'skills:training', title: 'Courses and training', text: s.skills.training, url: `${home}/#stack` })

  const sheet = `${home}/sheet`
  out.push({ id: 'sheet:origin', title: 'Origin story', text: text(s.sheet.origin, ...s.sheet.backstory), url: sheet })
  out.push({ id: 'sheet:languages', title: 'Languages', text: s.sheet.languages.map(l => `${l.name}: ${l.level}.`).join(' '), url: sheet })
  for (const group of ['abilities', 'stances', 'moments', 'quests'] as const) {
    for (const x of s.sheet[group] as { id: string, name: string, line: string }[]) {
      out.push({ id: `sheet:${group}:${x.id}`, title: x.name, text: x.line, url: sheet })
    }
  }
  for (const x of s.sheet.studying.items) out.push({ id: `sheet:studying:${x.id}`, title: `Studying: ${x.name}`, text: x.line, url: sheet })
  s.recommendations.forEach((q, i) => out.push({ id: `recommendation:${i + 1}`, title: `${q.name}, ${q.role}`, text: q.text, url: `${home}/#said` }))
  return out
}
