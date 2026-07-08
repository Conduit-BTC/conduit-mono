// Lexical tag suggestion (Tier 1): suggest product tags from title + summary by
// (a) direct matches — corpus tags whose text appears in the product copy — and
// (b) neighbor aggregation — tags of the most textually-similar corpus products,
// weighted by TF-IDF similarity. No ML, no network; runs over a locally-fetched
// corpus of {title, summary, tags}. Build the index once, suggest per keystroke.

export interface TagCorpusEntry {
  title: string
  summary?: string | null
  tags: readonly string[]
}

export interface TagSuggestionQuery {
  title: string
  summary?: string | null
  existingTags?: readonly string[]
  limit?: number
  neighborCount?: number
}

export interface TagSuggestion {
  tag: string
  score: number
  direct: boolean
}

interface CorpusDoc {
  tokens: Set<string>
  tagNorms: string[]
}

export interface TagCorpusIndex {
  docs: CorpusDoc[]
  documentFrequency: Map<string, number>
  documentCount: number
  /** normalized tag -> most common surface form */
  tagSurface: Map<string, string>
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "from",
  "is",
  "are",
  "be",
  "this",
  "that",
  "your",
  "you",
  "it",
  "as",
])

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 1 && !STOPWORDS.has(token)
  )
}

function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function buildTagCorpusIndex(
  corpus: readonly TagCorpusEntry[]
): TagCorpusIndex {
  const docs: CorpusDoc[] = []
  const documentFrequency = new Map<string, number>()
  // normalized tag -> surface form -> occurrences (to pick the common spelling)
  const surfaceCounts = new Map<string, Map<string, number>>()

  for (const entry of corpus) {
    const tokens = new Set(tokenize(`${entry.title} ${entry.summary ?? ""}`))
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }

    const tagNorms: string[] = []
    for (const rawTag of entry.tags) {
      const norm = normalizeTag(rawTag)
      if (!norm) continue
      tagNorms.push(norm)
      const surface = rawTag.trim()
      const counts = surfaceCounts.get(norm) ?? new Map<string, number>()
      counts.set(surface, (counts.get(surface) ?? 0) + 1)
      surfaceCounts.set(norm, counts)
    }
    docs.push({ tokens, tagNorms })
  }

  const tagSurface = new Map<string, string>()
  for (const [norm, counts] of surfaceCounts) {
    let best = norm
    let bestCount = -1
    for (const [surface, count] of counts) {
      if (count > bestCount) {
        best = surface
        bestCount = count
      }
    }
    tagSurface.set(norm, best)
  }

  return {
    docs,
    documentFrequency,
    documentCount: docs.length,
    tagSurface,
  }
}

export function suggestProductTags(
  index: TagCorpusIndex,
  query: TagSuggestionQuery
): TagSuggestion[] {
  const limit = query.limit ?? 8
  const neighborCount = query.neighborCount ?? 40
  const text = `${query.title} ${query.summary ?? ""}`
  const queryTokens = new Set(tokenize(text))
  const existing = new Set(
    (query.existingTags ?? []).map(normalizeTag).filter(Boolean)
  )

  const idf = (token: string): number =>
    Math.log(
      1 + index.documentCount / (1 + (index.documentFrequency.get(token) ?? 0))
    )

  // Rank corpus docs by summed IDF of shared tokens; keep the top neighbors.
  const neighbors: Array<{ doc: CorpusDoc; similarity: number }> = []
  if (queryTokens.size > 0) {
    for (const doc of index.docs) {
      let similarity = 0
      for (const token of doc.tokens) {
        if (queryTokens.has(token)) similarity += idf(token)
      }
      if (similarity > 0) neighbors.push({ doc, similarity })
    }
    neighbors.sort((a, b) => b.similarity - a.similarity)
    neighbors.length = Math.min(neighbors.length, neighborCount)
  }

  const scores = new Map<string, number>()
  for (const { doc, similarity } of neighbors) {
    const seen = new Set<string>()
    for (const norm of doc.tagNorms) {
      if (existing.has(norm) || seen.has(norm)) continue
      seen.add(norm)
      scores.set(norm, (scores.get(norm) ?? 0) + similarity)
    }
  }

  // Direct matches: a corpus tag whose normalized text appears in the product
  // copy verbatim (word-boundary), even if no similar product carried it.
  const paddedText = ` ${normalizeTag(text)} `
  const direct = new Set<string>()
  for (const norm of index.tagSurface.keys()) {
    if (!norm || existing.has(norm)) continue
    if (paddedText.includes(` ${norm} `)) {
      direct.add(norm)
      if (!scores.has(norm)) scores.set(norm, 0)
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => {
      const aDirect = direct.has(a[0]) ? 1 : 0
      const bDirect = direct.has(b[0]) ? 1 : 0
      if (aDirect !== bDirect) return bDirect - aDirect
      return b[1] - a[1]
    })
    .slice(0, limit)
    .map(([norm, score]) => ({
      tag: index.tagSurface.get(norm) ?? norm,
      score,
      direct: direct.has(norm),
    }))
}
