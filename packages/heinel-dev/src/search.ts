// A small BM25 keyword index over the site's text. Each chunk is one
// readable piece (a role, a project, one decision in a case) with a link
// back to where it appears on heinel.dev.

export type Chunk = { id: string, title: string, text: string, url: string }

const K1 = 1.2
const B = 0.75

export function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    .filter(t => t.length > 1)
    .map(t => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
}

export class Index {
  private docs: { chunk: Chunk, tf: Map<string, number>, len: number }[] = []
  private df = new Map<string, number>()
  private avg = 0

  constructor(chunks: Chunk[]) {
    for (const chunk of chunks) {
      const tf = new Map<string, number>()
      const words = tokens(`${chunk.title} ${chunk.text}`)
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1)
      this.docs.push({ chunk, tf, len: words.length })
    }
    this.avg = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length)
  }

  get size(): number {
    return this.docs.length
  }

  search(query: string, limit = 5): { chunk: Chunk, score: number }[] {
    const terms = [...new Set(tokens(query))]
    const n = this.docs.length
    const hits: { chunk: Chunk, score: number }[] = []
    for (const d of this.docs) {
      let score = 0
      for (const t of terms) {
        const f = d.tf.get(t)
        if (!f) continue
        const df = this.df.get(t) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / this.avg)))
      }
      if (score > 0) hits.push({ chunk: d.chunk, score })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

/** The sentence or two around the first matching word, for a short preview. */
export function snippet(text: string, query: string, max = 240): string {
  const wanted = new Set(tokens(query))
  const sentences = text.split(/(?<=[.!?])\s+/)
  const i = sentences.findIndex(s => tokens(s).some(t => wanted.has(t)))
  const picked = sentences.slice(Math.max(0, i), Math.max(0, i) + 2).join(' ')
  return picked.length > max ? picked.slice(0, max - 1).trimEnd() + '…' : picked
}
