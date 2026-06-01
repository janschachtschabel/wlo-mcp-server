/**
 * reranker.ts – Client-side relevance scoring + multi-query RRF reranking
 * Ported from wlo-search-app/src/searchStrategy.ts + api.ts
 */

import type { WloNode, SearchResponse, SearchCriterion, NgsearchContentType } from './wlo-api.js';
import { ngsearch } from './wlo-api.js';

// ── Query Expansion ──────────────────────────────────────────────────────────

// Kandidaten-Pool JE Such-Variante fürs Ranking — NICHT die ausgelieferte
// Trefferzahl (das ist maxResults). Kleinerer Pool = schnellere/kleinere
// Fetches bei minimal geringerem Recall. Default 25 (von 40 gesenkt),
// per Env ``WLO_POOL_SIZE`` übersteuerbar.
const POOL_SIZE: number = (() => {
  const v = parseInt(process.env['WLO_POOL_SIZE'] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 25;
})();

// O4: Obergrenze für parallele Query-Varianten (= parallele ngsearch-Calls).
// Varianten werden nach Gewicht sortiert und auf die besten MAX_VARIANTS
// gekürzt, damit ein synonym-/termreicher Query nicht zweistellig viele
// Backend-Calls auslöst. ``full:`` (Gewicht 1.0) bleibt dadurch immer dabei.
const MAX_VARIANTS = 5;

const DE_STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'eines',
  'und', 'oder', 'aber', 'als', 'auch', 'auf', 'aus', 'bei', 'bis', 'für', 'mit', 'nach',
  'von', 'vor', 'wie', 'über', 'unter', 'durch', 'gegen', 'ohne', 'zwischen',
  'ich', 'du', 'er', 'sie', 'wir', 'ihr', 'uns', 'sich',
  'ist', 'sind', 'war', 'hat', 'wird', 'kann', 'soll', 'zum', 'zur', 'vom',
  'nicht', 'noch', 'nur', 'sehr', 'schon', 'dann', 'wenn', 'dass', 'weil',
  'im', 'am', 'an', 'in', 'zu', 'so', 'es', 'ob',
]);

const SYNONYM_MAP: Record<string, string[]> = {
  'ki':                     ['künstliche intelligenz', 'artificial intelligence'],
  'künstliche intelligenz': ['ki'],
  'oer':                    ['open educational resources', 'freie bildungsmaterialien'],
  'mathe':                  ['mathematik'],
  'mathematik':             ['mathe'],
  'bio':                    ['biologie'],
  'biologie':               ['bio'],
  'physik':                 ['physics'],
  'chemie':                 ['chemistry'],
  'geo':                    ['geographie', 'erdkunde'],
  'geographie':             ['erdkunde', 'geo'],
  'erdkunde':               ['geographie', 'geo'],
  'info':                   ['informatik'],
  'informatik':             ['info', 'computer science'],
  'grundschule':            ['primarstufe'],
  'primarstufe':            ['grundschule'],
  'klima':                  ['klimawandel', 'klimaschutz'],
  'klimawandel':            ['klima', 'klimaschutz', 'climate change'],
  'nachhaltigkeit':         ['nachhaltige entwicklung', 'bne', 'sustainability'],
  'bne':                    ['bildung für nachhaltige entwicklung', 'nachhaltigkeit'],
};

interface QueryVariant {
  label: string;
  weight: number;
  criteria: SearchCriterion[];
}

function expandQuery(query: string): QueryVariant[] {
  const trimmed = query.trim();
  if (!trimmed) return [{ label: 'all', weight: 1, criteria: [{ property: 'ngsearchword', values: ['*'] }] }];

  const terms = trimmed.split(/\s+/).filter(t => t.length >= 2);
  const significantTerms = terms.filter(t => t.length >= 3);
  const contentTerms = terms.filter(t => !DE_STOPWORDS.has(t.toLowerCase()));
  const variants: QueryVariant[] = [];

  variants.push({ label: `full:"${trimmed}"`, weight: 1.0, criteria: [{ property: 'ngsearchword', values: [trimmed] }] });
  variants.push({ label: `title:"${trimmed}"`, weight: 0.95, criteria: [{ property: 'cclom:title', values: [trimmed] }] });

  if (significantTerms.length > 0) {
    variants.push({ label: `kw:${significantTerms.join(',')}`, weight: 0.9, criteria: [{ property: 'cclom:general_keyword', values: significantTerms }] });
  }

  if (contentTerms.length > 0 && contentTerms.length < terms.length) {
    variants.push({ label: `nostop:"${contentTerms.join(' ')}"`, weight: 0.85, criteria: [{ property: 'ngsearchword', values: [contentTerms.join(' ')] }] });
  }

  const queryLower = trimmed.toLowerCase();
  const synonymQueries = new Set<string>();
  for (const [term, synonyms] of Object.entries(SYNONYM_MAP)) {
    // Match on word boundaries (umlaut-aware) so a key like "klima" does NOT
    // fire inside "klimawandel", and the replace can't corrupt a substring
    // (the old `.replace(term, syn)` turned "geographie" → "geographiegrafie").
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\wäöüß])${esc}(?![\\wäöüß])`, 'i');
    if (re.test(queryLower)) {
      for (const syn of synonyms) {
        const expanded = queryLower.replace(re, syn);
        if (expanded !== queryLower) synonymQueries.add(expanded);
      }
    }
  }
  for (const synQuery of synonymQueries) {
    variants.push({ label: `syn:"${synQuery}"`, weight: 0.6, criteria: [{ property: 'ngsearchword', values: [synQuery] }] });
  }

  // O4: Die früheren Einzelterm-Varianten (term:"X", Gewicht 0.5) sind
  // entfernt — sie erzeugten je 1 ngsearch-Call PRO Term bei geringstem
  // Mehrwert, da die Keyword-Variante (kw:) die Einzelterme über
  // cclom:general_keyword bereits abdeckt. Stattdessen: nach Gewicht
  // sortieren und auf die besten MAX_VARIANTS deckeln.
  variants.sort((a, b) => b.weight - a.weight);
  return variants.slice(0, MAX_VARIANTS);
}

// ── Relevance Scoring ────────────────────────────────────────────────────────

function termInText(term: string, text: string): boolean {
  return text.includes(term);
}

function computeRelevanceScore(node: WloNode, query: string): number {
  let score = 0;
  const props = node.properties ?? {};
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2);

  const title = (props['cclom:title']?.[0] ?? props['cm:name']?.[0] ?? '').toLowerCase();
  const desc  = (props['cclom:general_description']?.[0] ?? '').toLowerCase();
  const keywords = (props['cclom:general_keyword'] ?? []).map((k: string) => k.toLowerCase());
  const allKw = keywords.join(' ');

  // Title relevance
  if (title.includes(queryLower)) {
    score += 30;
    if (title === queryLower) score += 20;
    else if (title.startsWith(queryLower)) score += 10;
  } else {
    for (const term of queryTerms) {
      if (termInText(term, title)) score += 8;
    }
    if (queryTerms.length > 1 && queryTerms.every(t => termInText(t, title))) score += 12;
  }

  // Keyword relevance
  let kwHits = 0;
  for (const term of queryTerms) {
    if (keywords.includes(term)) { score += 10; kwHits++; }
    else if (termInText(term, allKw)) score += 5;
  }
  if (queryTerms.length > 1 && kwHits === queryTerms.length) score += 10;

  // Description relevance
  if (desc.includes(queryLower)) score += 8;
  else { for (const term of queryTerms) { if (termInText(term, desc)) score += 3; } }

  // Penalty: not in title or keywords
  const inTitle = queryTerms.some(t => termInText(t, title));
  const inKw    = queryTerms.some(t => termInText(t, allKw));
  if (!inTitle && !inKw) score -= 20;

  // Metadata quality
  if (node.preview?.url && !node.preview.isIcon) score += 3;
  if (props['ccm:educationalcontext']?.length) score += 2;
  if (props['ccm:taxonid']?.length) score += 2;
  if (props['ccm:oeh_lrt_aggregated']?.length) score += 1;
  const license = props['ccm:commonlicense_key']?.[0] ?? '';
  if (['CC_0', 'CC_BY', 'CC_BY_SA', 'PDM'].includes(license)) score += 3;
  if (desc.length > 100) score += 2;
  else if (desc.length > 30) score += 1;
  if (props['ccm:oeh_publisher_combined']?.[0]) score += 1;
  if (props['ccm:wwwurl']?.[0] ?? node.content?.url) score += 1;

  return Math.max(score, 0);
}

// ── Merge + RRF ranking ──────────────────────────────────────────────────────

const RRF_K = 60;

interface ScoredNode {
  node: WloNode;
  nodeId: string;
  rrfScore: number;
  qualityScore: number;
  finalScore: number;
  appearances: number;
}

function getNodeId(node: WloNode): string {
  return node.ref?.id ?? node.properties?.['sys:node-uuid']?.[0] ?? '';
}

function isDeletedNode(node: WloNode): boolean {
  const props = node.properties ?? {};
  const title = props['cclom:title']?.[0] ?? props['cm:name']?.[0] ?? node.name ?? '';
  const desc  = props['cclom:general_description']?.[0] ?? '';
  if (title.includes('Element wurde gelöscht') || title.includes('Element was removed')) return true;
  if (desc.includes('Element wurde gelöscht') || desc.includes('Element was removed')) return true;
  if (!title.trim() && !node.title) return true;
  return false;
}

function mergeAndRank(
  results: { variant: QueryVariant; response: SearchResponse }[],
  query: string,
): ScoredNode[] {
  const nodeMap = new Map<string, ScoredNode>();

  for (const { variant, response } of results) {
    for (let rank = 0; rank < response.nodes.length; rank++) {
      const node = response.nodes[rank];
      const nodeId = getNodeId(node);
      if (!nodeId) continue;
      const rrfContribution = variant.weight / (RRF_K + rank + 1);
      if (nodeMap.has(nodeId)) {
        const ex = nodeMap.get(nodeId)!;
        ex.rrfScore += rrfContribution;
        ex.appearances += 1;
      } else {
        nodeMap.set(nodeId, { node, nodeId, rrfScore: rrfContribution, qualityScore: 0, finalScore: 0, appearances: 1 });
      }
    }
  }

  const entries = Array.from(nodeMap.values());
  for (const e of entries) e.qualityScore = computeRelevanceScore(e.node, query);

  const maxRrf     = Math.max(...entries.map(e => e.rrfScore), 0.001);
  const maxQuality = Math.max(...entries.map(e => e.qualityScore), 1);
  for (const e of entries) {
    const normRrf     = e.rrfScore / maxRrf;
    const normQuality = e.qualityScore / maxQuality;
    const bonus       = Math.min(e.appearances / results.length, 1) * 0.1;
    e.finalScore = normQuality * 0.8 + normRrf * 0.1 + bonus;
  }

  // Deterministic tie-breaker: when scores are equal, sort by nodeId
  // (lexicographically). Otherwise the order depends on the JS engine's
  // sort stability + insertion order from the parallel `Promise.allSettled`
  // — which can flip between calls and gives the impression of "random"
  // results.
  entries.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.nodeId.localeCompare(b.nodeId);
  });

  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  const minScore   = Math.max(5, queryTerms.length * 3);
  const passing = entries.filter(e => e.qualityScore >= minScore);
  // Graceful degradation: if the text-overlap quality floor would discard
  // EVERY hit (e.g. the backend matched via full-text/PDF body or keywords
  // not echoed in cclom:title/general_keyword), fall back to the RRF-ranked
  // pool instead of returning nothing. `entries` is already sorted by
  // finalScore, so the best candidates stay on top.
  return passing.length > 0 ? passing : entries;
}

// ── Public: Enhanced search ──────────────────────────────────────────────────

export async function enhancedSearch(
  query: string,
  contentType: NgsearchContentType,
  additionalCriteria: SearchCriterion[],
  maxResults: number,
): Promise<SearchResponse> {
  const variants = expandQuery(query);

  const settled = await Promise.allSettled(
    variants.map(async variant => {
      const criteria = [...variant.criteria, ...additionalCriteria];
      const response = await ngsearch(criteria, contentType, POOL_SIZE);
      return { variant, response };
    })
  );

  const successful = settled
    .filter((r): r is PromiseFulfilledResult<{ variant: QueryVariant; response: SearchResponse }> => r.status === 'fulfilled')
    .map(r => r.value);

  if (successful.length === 0) return { nodes: [], pagination: { total: 0, from: 0, count: 0 } };

  const ranked   = mergeAndRank(successful, query);
  const filtered = ranked.filter(r => !isDeletedNode(r.node));
  const topNodes = filtered.slice(0, maxResults).map(r => r.node);
  // Report the TRUE backend hit count of the primary full-query variant
  // (label "full:…") as the total. Previously this was clamped to
  // filtered.length (≤ POOL_SIZE = 40), badly under-reporting "found N" for
  // broad queries. `count` stays the number actually returned this page.
  const fullVariant = successful.find(r => r.variant.label.startsWith('full:'));
  const apiTotal = fullVariant
    ? fullVariant.response.pagination.total
    : Math.max(...successful.map(r => r.response.pagination.total), 0);

  return {
    nodes: topNodes,
    pagination: { total: apiTotal, from: 0, count: topNodes.length },
  };
}

/** Simple reranking for already-fetched nodes (used for collection contents). */
export function rerankNodes(nodes: WloNode[], query: string): WloNode[] {
  if (!query.trim() || nodes.length === 0) return nodes;
  return nodes
    .filter(n => !isDeletedNode(n))
    .map(n => ({ node: n, score: computeRelevanceScore(n, query), id: getNodeId(n) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    })
    .map(s => s.node);
}

/** Deterministic alphabetical sort by title (with nodeId tie-breaker). */
export function sortByTitle(nodes: WloNode[]): WloNode[] {
  return [...nodes].sort((a, b) => {
    const ta = (a.properties?.['cclom:title']?.[0] ?? a.properties?.['cm:name']?.[0] ?? a.name ?? '').toLowerCase();
    const tb = (b.properties?.['cclom:title']?.[0] ?? b.properties?.['cm:name']?.[0] ?? b.name ?? '').toLowerCase();
    if (ta !== tb) return ta.localeCompare(tb, 'de');
    return getNodeId(a).localeCompare(getNodeId(b));
  });
}
