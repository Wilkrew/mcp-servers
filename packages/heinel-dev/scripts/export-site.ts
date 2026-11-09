// Builds data/site.json from a checkout of the heinel.dev site repo:
//
//   npm run export-site -- ../heinel-site
//
// Only what the public site shows goes in: visible roles and projects, the
// public case pages, and contact details the site itself publishes. Hidden
// entries, the unlisted delivery case and the birthday on the sheet stay out.
// Run it again whenever the site's content changes.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const site = resolve(process.argv[2] ?? '../heinel-site')
const load = async (name: string) => import(pathToFileURL(`${site}/content/${name}.ts`).href)

const { default: profile } = await load('profile')
const { siteUrl } = await load('meta')
const { default: experience } = await load('experience')
const { visibleProjects } = await load('projects')
const { default: skillGroups, training } = await load('skills')
const { default: suntarbetsliv } = await load('suntarbetsliv')
const { default: methods } = await load('methods')
const { default: nether } = await load('nether')
const { discreet } = await load('delivery')
const { default: sheet } = await load('sheet')
const { homeQuotes, sheetQuotes } = await load('recommendation')

type Link = { href: string, label: string }
type Quote = { text: string, name: string, role: string, source: string }

const abs = (href?: string) => (!href ? undefined : href.startsWith('/') ? siteUrl + href : href)
const links = (list?: Link[]) => list?.map(l => ({ label: l.label, url: abs(l.href) }))
const quote = (q?: Quote) => (q ? { text: q.text, name: q.name, role: q.role, source: q.source } : undefined)

const commit = execFileSync('git', ['-C', site, 'rev-parse', '--short', 'HEAD']).toString().trim()

const quotes = new Map<string, Quote>()
for (const q of [...homeQuotes, ...sheetQuotes] as Quote[]) quotes.set(q.text, q)

const { card: _card, metaDescription: _meta, ...delivery } = discreet

const data = {
  source: { site: siteUrl, commit, note: 'Generated from the public content of heinel.dev. Do not edit by hand.' },
  profile: {
    name: profile.name,
    location: profile.location,
    tagline: profile.sticker,
    headline: profile.sellingLine,
    facts: profile.subject.filter((r: { label: string }) => r.label !== 'Name'),
    now: profile.now.map((n: { label: string, text: string }) => ({ label: n.label, text: n.text })),
    contact: {
      email: profile.contactEmail,
      website: siteUrl,
      linkedin: profile.links.linkedin,
      github: profile.links.github
    },
    cv: { en: abs(profile.cv), sv: abs(profile.cvSv) }
  },
  experience: experience
    .filter((r: { visible: boolean }) => r.visible)
    .map((r: any) => ({
      id: r.id,
      company: r.company,
      title: r.title,
      period: r.period || r.periodLabel || '',
      lane: r.lane,
      summary: r.summary,
      parts: r.parts?.map((p: any) => ({ title: p.title, period: p.period, summary: p.summary })),
      tags: r.tags,
      quote: quote(r.quote)
    })),
  work: visibleProjects.map((p: any) => ({
    id: p.id,
    title: p.title,
    kind: p.kind,
    period: p.period,
    summary: p.summary,
    highlights: p.highlights,
    result: p.result,
    tags: p.tags,
    url: abs(p.href),
    links: links(p.links)
  })),
  cases: {
    suntarbetsliv: { url: `${siteUrl}/suntarbetsliv`, ...suntarbetsliv, links: links(suntarbetsliv.links) },
    'ai-skills': { url: `${siteUrl}/methods`, ...methods },
    delivery: { url: `${siteUrl}/delivery`, ...delivery },
    nether: { url: `${siteUrl}/nether`, ...nether }
  },
  skills: { groups: skillGroups, training },
  sheet: {
    class: sheet.className,
    calling: sheet.calling,
    origin: sheet.origin,
    languages: sheet.languages,
    studying: sheet.studied,
    abilities: sheet.abilities,
    proficiencies: sheet.proficiencies,
    stances: sheet.stances,
    moments: sheet.moments,
    quests: sheet.quests,
    training: sheet.training,
    backstory: sheet.backstory
  },
  recommendations: [...quotes.values()].map(quote)
}

const out = new URL('../data/site.json', import.meta.url)
writeFileSync(out, JSON.stringify(data, null, 2) + '\n')
console.log(`Wrote ${out.pathname} from ${site} at ${commit}`)
