/**
 * server.ts – MCP Server factory with all WLO tools registered.
 * Transport-agnostic: connect stdio or Streamable HTTP outside this file.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { SearchCriterion } from './wlo-api.js';
import { ngsearch, searchCollectionsByKeyword, getCollectionContents, getChildCollections, getNodeMetadata, getNodeTextContent, getNodeParents, WLO_ROOT_COLLECTION_ID, searchPageVariants, getCollectionThemePages, getTopicPageContent, buildTopicPageUrl, buildRenderUrl, BASE_URL, WLO_REPOSITORY_URL, resolveVariantCollection } from './wlo-api.js';
import type { TargetGroup, ThemePageInfo, WloNode } from './wlo-api.js';
import { enhancedSearch, rerankNodes, sortByTitle } from './reranker.js';
import { formatNodes, formatNode, renderToText, renderToJson } from './formatter.js';
import type { FormattedNode } from './formatter.js';
import { resolveVocab, listVocab, labelFromUri, type VocabKey } from './vocabs.js';

// ── Topic-page display-title resolution ─────────────────────────────────────

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for technical, non-human-readable identifiers that must never be
 * shown as a Themenseite title — namely the auto-generated `cm:name` of a
 * page-variant node ("PAGE_VARIANT_<uuid>") and bare node UUIDs.
 */
function isPlaceholderTitle(s: string | undefined | null): boolean {
  const t = (s ?? '').trim();
  if (!t) return true;
  if (/^page[_-]?variant/i.test(t)) return true;
  if (_UUID_RE.test(t)) return true;
  return false;
}

/**
 * Pick the best human-readable title for a Themenseite, in priority order:
 *   1. owning collection name (`cclom:title`/`cm:name` of the collection),
 *   2. the variant node's own `cm:title` ("Seiten-Variante 1"),
 *   3. the variant's `cm:name` — only if it is NOT a PAGE_VARIANT/UUID
 *      placeholder.
 * Falls back to a generic "Themenseite" so a raw UUID is never displayed.
 */
function pickThemePageTitle(r: ThemePageInfo): string {
  const candidates = [r.collectionName, r.variantTitle, r.variantName];
  for (const c of candidates) {
    const t = (c ?? '').trim();
    if (t && !isPlaceholderTitle(t)) return t;
  }
  return 'Themenseite';
}

/**
 * Run an async mapper over `items` with a bounded number of concurrent
 * in-flight tasks (worker-pool). Keeps result order. Used to fan out the
 * per-variant enrichment in search_wlo_topic_pages Mode C WITHOUT firing
 * 100+ simultaneous upstream fetches (which risks connection exhaustion /
 * upstream throttling / the 30s Vercel limit) — a controlled pool is both
 * stable and, combined with caching, fast.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ── Query metadata for downstream consumers (backend → frontend) ────────────

export interface LabeledCriterion {
  property: string;
  values: string[];
  label?: string;
}

export interface QueryMeta {
  toolName: string;
  queryType: string;
  searchTerm: string;
  criteria: LabeledCriterion[];
  pagination: { maxItems: number; skipCount: number; totalResults: number };
  repositoryUrl: string;
  searchUrl: string;
}

const SEARCH_URL_FILTER_PROPS = new Set([
  'ccm:taxonid',
  'ccm:educationalcontext',
  'ccm:oeh_lrt_aggregated',
  'ccm:educationalintendedenduserrole',
  'ccm:oeh_publisher_combined',
]);

function buildSearchUrl(repoUrl: string, searchTerm: string, criteria: LabeledCriterion[]): string {
  const filterObj: Record<string, string[]> = {};
  for (const c of criteria) {
    if (SEARCH_URL_FILTER_PROPS.has(c.property)) {
      filterObj[c.property] = c.values;
    }
  }
  const params = new URLSearchParams();
  if (searchTerm) params.set('q', searchTerm);
  if (Object.keys(filterObj).length) params.set('filters', JSON.stringify(filterObj));
  return `${repoUrl}/components/search?${params.toString()}`;
}

function queryMetaContent(meta: Omit<QueryMeta, 'searchUrl'>): { type: 'text'; text: string } {
  const searchUrl = buildSearchUrl(meta.repositoryUrl, meta.searchTerm, meta.criteria);
  return { type: 'text' as const, text: JSON.stringify({ _queryMeta: { ...meta, searchUrl } }) };
}

// ── Shared filter builder ────────────────────────────────────────────────────

function buildFilterCriteria(params: {
  educationalContext?: string;
  discipline?: string;
  userRole?: string;
  publisher?: string;
  learningResourceType?: string;
}): { criteria: SearchCriterion[]; labeled: LabeledCriterion[] } {
  const criteria: SearchCriterion[] = [];
  const labeled: LabeledCriterion[] = [];

  if (params.educationalContext) {
    const uri = resolveVocab(params.educationalContext, 'educationalContext');
    if (uri) {
      criteria.push({ property: 'ccm:educationalcontext', values: [uri] });
      labeled.push({ property: 'ccm:educationalcontext', values: [uri], label: params.educationalContext });
    }
  }
  if (params.discipline) {
    const uri = resolveVocab(params.discipline, 'discipline');
    if (uri) {
      criteria.push({ property: 'ccm:taxonid', values: [uri] });
      labeled.push({ property: 'ccm:taxonid', values: [uri], label: params.discipline });
    }
  }
  if (params.userRole) {
    const uri = resolveVocab(params.userRole, 'userRole');
    if (uri) {
      criteria.push({ property: 'ccm:educationalintendedenduserrole', values: [uri] });
      labeled.push({ property: 'ccm:educationalintendedenduserrole', values: [uri], label: params.userRole });
    }
  }
  if (params.publisher) {
    criteria.push({ property: 'ccm:oeh_publisher_combined', values: [params.publisher] });
    labeled.push({ property: 'ccm:oeh_publisher_combined', values: [params.publisher], label: params.publisher });
  }
  const lrt = resolveVocab(params.learningResourceType ?? '', 'lrt');
  if (lrt) {
    criteria.push({ property: 'ccm:oeh_lrt_aggregated', values: [lrt] });
    labeled.push({ property: 'ccm:oeh_lrt_aggregated', values: [lrt], label: params.learningResourceType });
  }

  return { criteria, labeled };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  // Repository URL kommt global aus dem ``WLO_REPOSITORY_URL``-Env (siehe
  // ``wlo-api.ts``). Pro Server-Instanz wird ein einziger Edu-Sharing-
  // Endpoint adressiert — Switch zwischen Prod/Staging passiert per
  // separatem Deployment mit unterschiedlicher Env-Variable.

  const server = new McpServer({
    name: 'wlo-mcp',
    version: '1.0.0',
  });

  // ── Tool 1: search_wlo_collections ────────────────────────────────────────
  server.tool(
    'search_wlo_collections',
    `Search WirLernenOnline (WLO) for Sammlungen (= Themenseiten).
In WLO, a "Sammlung" is the same as a "Themenseite": a curated thematic page that bundles
educational content items in swimlanes (Schwimmlinien/Karussells) grouped by topic, subject or level.
Users may ask for "Themenseite Algebra", "Sammlung Klimawandel" or "Portal Mathematik" – these all refer to collections.
Use the returned nodeId with get_collection_contents to retrieve the actual content items.
Filters accept both German labels (e.g. "Mathematik", "Grundschule", "Lehrer/in") and full URIs.`,
    {
      query: z.string().optional().default('').describe('Search query in German, e.g. "Klimawandel" or "Algebra". Leave empty to browse top-level collections.'),
      parentNodeId: z.string().optional().describe(
        'NodeId of a parent collection to search within (e.g. Mathematik nodeId to find "Algebra" inside it). ' +
        'Leave empty to search from the WLO root. Returned by a previous search_wlo_collections call.'
      ),
      educationalContext: z.string().optional().describe(
        'Educational level (Bildungsstufe): e.g. "Primarstufe", "Sekundarstufe I", "Hochschule", or URI'
      ),
      discipline: z.string().optional().describe(
        'Subject (Fach/Schulfach): e.g. "Mathematik", "Biologie", "Informatik", or URI'
      ),
      userRole: z.string().optional().describe(
        'Target audience (Zielgruppe): e.g. "Lehrer/in", "Lerner/in", "Eltern", or URI'
      ),
      maxResults: z.number().int().min(1).max(50).optional().default(5).describe(
        'Maximum number of results (1–20, default 5)'
      ),
      excludeNodeIds: z.array(z.string()).optional().describe(
        'Skip these node IDs in the result (already-seen items, e.g. for paginated drill-downs)'
      ),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown').describe(
        '"markdown" (default, human-readable) or "json" (structured)'
      ),
    },
    async (params) => {
      const maxResults = params.maxResults ?? 5;
      const excluded = new Set(params.excludeNodeIds ?? []);

      // Keyword match: split query into words, match if ANY word hits name/title/desc
      const matchesQuery = (node: import('./wlo-api.js').WloNode, q: string): boolean => {
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        const haystack = [
          node.properties?.['cm:name']?.[0] ?? node.name ?? '',
          node.properties?.['cclom:title']?.[0] ?? node.title ?? '',
          node.properties?.['cclom:general_description']?.[0] ?? '',
        ].join(' ').toLowerCase();
        return words.some(w => haystack.includes(w));
      };

      const collLabeledCriteria: LabeledCriterion[] = [];
      if (params.educationalContext) {
        const uri = resolveVocab(params.educationalContext, 'educationalContext');
        if (uri) collLabeledCriteria.push({ property: 'ccm:educationalcontext', values: [uri], label: params.educationalContext });
      }
      if (params.discipline) {
        const uri = resolveVocab(params.discipline, 'discipline');
        if (uri) collLabeledCriteria.push({ property: 'ccm:taxonid', values: [uri], label: params.discipline });
      }
      if (params.userRole) {
        const uri = resolveVocab(params.userRole, 'userRole');
        if (uri) collLabeledCriteria.push({ property: 'ccm:educationalintendedenduserrole', values: [uri], label: params.userRole });
      }

      const renderOut = (nodes: WloNode[], total: number, qType: string, emptyMsg = 'Keine Sammlungen gefunden.') => {
        const kept = excluded.size
          ? nodes.filter(n => !excluded.has(n.ref?.id ?? ''))
          : nodes;
        // Einheitliches Reranking (wie bei Inhalten): bei vorhandenem Query nach
        // Relevanz; rerankNodes ist bei leerem Query (Browse) ein No-op und
        // entfernt sonst nur gelöschte Knoten — kann nichts Relevantes verlieren.
        const ranked = rerankNodes(kept, params.query ?? '');
        const formatted = formatNodes(ranked.slice(0, maxResults));
        const text = (params.outputFormat ?? 'markdown') === 'json'
          ? renderToJson(formatted, total)
          : (renderToText(formatted, total) || emptyMsg);
        const baseCriteria: LabeledCriterion[] = params.query?.trim()
          ? [{ property: 'ngsearchword', values: [params.query] }]
          : [];
        const meta = queryMetaContent({
          toolName: 'search_wlo_collections',
          queryType: qType,
          searchTerm: params.query ?? '',
          criteria: [...baseCriteria, ...collLabeledCriteria],
          pagination: { maxItems: maxResults, skipCount: 0, totalResults: total },
          repositoryUrl: WLO_REPOSITORY_URL,
        });
        return { content: [{ type: 'text' as const, text }, meta] };
      };

      try {
        const query    = params.query.trim();
        const startId  = params.parentNodeId ?? WLO_ROOT_COLLECTION_ID;

        if (query && !params.parentNodeId) {
          const directHits = await searchCollectionsByKeyword(query, maxResults);
          if (directHits.length > 0) {
            return renderOut(directHits, directHits.length, 'keyword_collections');
          }
        }

        const level1 = await getChildCollections(startId, 100);

        if (!query) {
          return renderOut(level1, level1.length, 'collection_children');
        }

        let matches = level1.filter(n => matchesQuery(n, query));

        // O6: Breite des rekursiven Baumlaufs deckeln, damit der Fallback nie
        // zur 100+-Parallel-Call-Lawine wird. Direkte Treffer in level1 bleiben
        // vollständig erhalten; nur die Expansion in tiefere Ebenen ist begrenzt.
        const LEVEL2_PARENT_CAP = 25;
        const level2Parents = level1.slice(0, LEVEL2_PARENT_CAP);
        if (level1.length > LEVEL2_PARENT_CAP) {
          console.warn(`[wlo-mcp] collection search: level2-Expansion gedeckelt ${level1.length} → ${LEVEL2_PARENT_CAP} Parents (query="${query}")`);
        }
        const level2Results = await Promise.allSettled(
          level2Parents.map(parent => getChildCollections(parent.ref?.id ?? '', 50))
        );
        const allLevel2Nodes: import('./wlo-api.js').WloNode[] = [];
        for (const r of level2Results) {
          if (r.status === 'fulfilled') {
            allLevel2Nodes.push(...r.value);
            matches.push(...r.value.filter(n => matchesQuery(n, query)));
          }
        }

        if (matches.length === 0) {
          const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const scoreNode = (n: import('./wlo-api.js').WloNode): number => {
            const text = [
              n.properties?.['cm:name']?.[0] ?? '',
              n.properties?.['cclom:title']?.[0] ?? '',
              n.properties?.['cclom:general_description']?.[0] ?? '',
            ].join(' ').toLowerCase();
            return queryWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
          };
          const anyScored = allLevel2Nodes.some(n => scoreNode(n) > 0);
          const LEVEL3_PARENT_CAP = 15;
          const level2Candidates = anyScored
            ? [...allLevel2Nodes].sort((a, b) => scoreNode(b) - scoreNode(a)).slice(0, LEVEL3_PARENT_CAP)
            : allLevel2Nodes.slice(0, LEVEL3_PARENT_CAP);

          const level3Results = await Promise.allSettled(
            level2Candidates.map(parent => getChildCollections(parent.ref?.id ?? '', 30))
          );
          for (const r of level3Results) {
            if (r.status === 'fulfilled') matches.push(...r.value.filter(n => matchesQuery(n, query)));
          }
        }

        if (matches.length === 0) {
          return { content: [{ type: 'text', text: `Keine Sammlungen gefunden für "${query}". Versuche einen übergeordneten Begriff (z.B. "Mathematik" statt "Bruchrechnung") oder frag nach verfügbaren Sammlungen ohne Suchbegriff.` }] };
        }

        return renderOut(matches, matches.length, 'collection_tree_traversal');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler bei der Sammlungssuche: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool 2: search_wlo_content ────────────────────────────────────────────
  server.tool(
    'search_wlo_content',
    `Search WirLernenOnline (WLO) for individual educational content items (Inhalte/Materialien).
Content items are files such as worksheets, videos, interactive media, lesson plans, etc.
Supports full-text search with multi-query expansion and quality-based reranking.
Filters accept both German labels and full URIs.`,
    {
      query: z.string().describe('Search query in German, e.g. "Bruchrechnung Grundschule" or "Klimawandel interaktiv"'),
      educationalContext: z.string().optional().describe(
        'Educational level: e.g. "Primarstufe", "Sekundarstufe I", "Sekundarstufe II", "Hochschule", or URI'
      ),
      discipline: z.string().optional().describe(
        'Subject: e.g. "Mathematik", "Biologie", "Deutsch", "Informatik", or URI'
      ),
      userRole: z.string().optional().describe(
        'Target audience: e.g. "Lehrer/in", "Lerner/in", or URI'
      ),
      learningResourceType: z.string().optional().describe(
        'Resource type: e.g. "Arbeitsblatt", "Video", "Unterrichtsplan", "Interaktives Medium", or URI'
      ),
      publisher: z.string().optional().describe(
        'Filter by content publisher/source, e.g. "Klexikon", "ZUM", "Serlo", "Khan Academy". ' +
        'Matches against the ccm:oeh_publisher_combined property.'
      ),
      maxResults: z.number().int().min(1).max(50).optional().default(8).describe(
        'Maximum number of results (1–20, default 8)'
      ),
      excludeNodeIds: z.array(z.string()).optional().describe(
        'Skip these node IDs in the result (already-seen items)'
      ),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown'),
    },
    async (params) => {
      const { criteria: filters, labeled: labeledFilters } = buildFilterCriteria(params);
      const maxResults = params.maxResults ?? 8;
      const excluded = new Set(params.excludeNodeIds ?? []);

      try {
        let response;
        let queryType: string;
        let effectiveCriteria: LabeledCriterion[];
        const pool = excluded.size > 0 ? Math.min(maxResults + excluded.size, 20) : maxResults;
        if (params.query.trim()) {
          response = await enhancedSearch(params.query, 'FILES', filters, pool);
          queryType = 'ngsearch_enhanced';
          effectiveCriteria = [{ property: 'ngsearchword', values: [params.query] }, ...labeledFilters];
        } else {
          const browseCriteria: SearchCriterion[] = filters.length
            ? filters
            : [{ property: 'ngsearchword', values: ['*'] }];
          response = await ngsearch(browseCriteria, 'FILES', pool);
          queryType = 'ngsearch';
          effectiveCriteria = labeledFilters.length
            ? labeledFilters
            : [{ property: 'ngsearchword', values: ['*'] }];
        }

        const kept = excluded.size
          ? response.nodes.filter(n => !excluded.has(n.ref?.id ?? ''))
          : response.nodes;
        const formatted = formatNodes(kept.slice(0, maxResults));
        const text = (params.outputFormat ?? 'markdown') === 'json'
          ? renderToJson(formatted, response.pagination.total)
          : (renderToText(formatted, response.pagination.total) || 'Keine Inhalte gefunden.');

        const meta = queryMetaContent({
          toolName: 'search_wlo_content',
          queryType,
          searchTerm: params.query ?? '',
          criteria: effectiveCriteria,
          pagination: { maxItems: maxResults, skipCount: 0, totalResults: response.pagination.total },
          repositoryUrl: WLO_REPOSITORY_URL,
        });
        return { content: [{ type: 'text', text }, meta] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler bei der Inhaltssuche: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool 3: get_collection_contents ───────────────────────────────────────
  server.tool(
    'get_collection_contents',
    `Retrieve content items and/or sub-collections from a WLO Sammlung (Themenseite) by its nodeId.
In WLO, Sammlungen are displayed as Themenseiten: thematic pages that bundle content in swimlanes.
This tool fetches what is inside those swimlanes.
The nodeId is returned by search_wlo_collections.
Use contentFilter="files" (default) for learning materials, "folders" for sub-collections (Unter-Themenseiten),
or "both" for everything. Set includeSubcollections=true to traverse the full sub-tree recursively.`,
    {
      nodeId: z.string().describe('Collection node ID from search_wlo_collections results'),
      query: z.string().optional().describe(
        'Optional search/filter query to rerank results within the collection'
      ),
      contentFilter: z.enum(['files', 'folders', 'both']).optional().default('files').describe(
        '"files" = Lernmaterialien (default), "folders" = Sub-Sammlungen, "both" = alles'
      ),
      includeSubcollections: z.boolean().optional().default(false).describe(
        'Wenn true: Sub-Sammlungen rekursiv durchsuchen und alle Inhalte sammeln (nur für contentFilter="files")'
      ),
      maxResults: z.number().int().min(1).max(100).optional().default(20).describe(
        'Maximum number of items to return (1–100, default 20)'
      ),
      skipCount: z.number().int().min(0).optional().default(0).describe(
        'Number of items to skip for pagination (default 0)'
      ),
      excludeNodeIds: z.array(z.string()).optional().describe(
        'Skip these node IDs in the result'
      ),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown'),
    },
    async (params) => {
      const filter = (params.contentFilter ?? 'files') as 'files' | 'folders' | 'both';
      const maxResults = params.maxResults ?? 20;
      const skipCount = params.skipCount ?? 0;
      const excluded = new Set(params.excludeNodeIds ?? []);

      try {
        let allNodes: FormattedNode[] = [];
        let totalHits = 0;

        if (params.includeSubcollections && filter === 'files') {
          // Recursive: collect files from root + all sub-collections
          const collectionQueue = [params.nodeId];
          const visited = new Set<string>();

          while (collectionQueue.length > 0 && allNodes.length < maxResults) {
            const cid = collectionQueue.shift()!;
            if (visited.has(cid)) continue;
            visited.add(cid);

            // Fetch files in this collection
            const filesResp = await getCollectionContents(cid, 'files', 50);
            totalHits += filesResp.pagination.total;
            let fileNodes = filesResp.nodes;
            if (excluded.size) fileNodes = fileNodes.filter(n => !excluded.has(n.ref?.id ?? ''));
            if (params.query?.trim()) fileNodes = rerankNodes(fileNodes, params.query);
            allNodes.push(...formatNodes(fileNodes));

            // Fetch sub-collections and queue them
            const subs = await getChildCollections(cid);
            for (const sub of subs) {
              const subId = sub.ref?.id ?? sub.properties?.['sys:node-uuid']?.[0];
              if (subId && !visited.has(subId)) collectionQueue.push(subId);
            }
          }
          allNodes = allNodes.slice(0, maxResults);
        } else {
          const response = await getCollectionContents(params.nodeId, filter, maxResults + excluded.size, skipCount);
          totalHits = response.pagination.total;
          let nodes = response.nodes;
          if (excluded.size) nodes = nodes.filter(n => !excluded.has(n.ref?.id ?? ''));
          if (params.query?.trim() && filter !== 'folders') {
            nodes = rerankNodes(nodes, params.query);
          }
          allNodes = formatNodes(nodes.slice(0, maxResults));
        }

        const text = (params.outputFormat ?? 'markdown') === 'json'
          ? renderToJson(allNodes, totalHits)
          : (renderToText(allNodes, totalHits) || 'Sammlung ist leer oder nodeId nicht gefunden.');
        const meta = queryMetaContent({
          toolName: 'get_collection_contents',
          queryType: params.includeSubcollections ? 'collection_children_recursive' : 'collection_children',
          searchTerm: params.query ?? '',
          criteria: [{ property: 'nodeId', values: [params.nodeId] },
                     { property: 'contentFilter', values: [filter] }],
          pagination: { maxItems: maxResults, skipCount, totalResults: totalHits },
          repositoryUrl: WLO_REPOSITORY_URL,
        });
        return { content: [{ type: 'text', text }, meta] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler beim Abruf der Sammlungsinhalte: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool 4: get_node_details ────────────────────────────────────────────────
  server.tool(
    'get_node_details',
    `Retrieve detailed metadata, stored full-text content, and/or parent collections for a specific WLO node.

Returns the SAME field structure as search tools (formatNode):
title, description, keywords, disciplines (labels), educationalContexts (labels),
userRoles (labels), learningResourceTypes (labels), license (label), publisher,
url, previewUrl, topicPageUrl, nodeType.

Plus optional:
- textContent: the crawled/stored full text of the linked web page or document
- parents: the collection(s) this node belongs to (useful to find which Sammlung a content item is in)
- raw: the original ccm:* / cclom:* property URIs (for debugging / advanced use)`,
    {
      nodeId: z.string().describe('Node ID of a content item or collection (from search results)'),
      includeTextContent: z.boolean().optional().default(false).describe(
        'Also fetch the stored full-text content of the node (crawled webpage/PDF text)'
      ),
      includeParents: z.boolean().optional().default(false).describe(
        'Also fetch the parent collections this node belongs to'
      ),
      includeRaw: z.boolean().optional().default(false).describe(
        'Include raw URI values alongside the resolved labels'
      ),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown').describe(
        '"markdown" (default, human-readable) or "json" (structured data, easier to parse for callers)'
      ),
    },
    async (params) => {
      try {
        const node = await getNodeMetadata(params.nodeId);
        if (!node) {
          return { content: [{ type: 'text', text: `Node ${params.nodeId} nicht gefunden.` }] };
        }

        const props = node.properties ?? {};
        const formatted = formatNode(node);

        // Extras that don't fit into FormattedNode
        const renderUrl = buildRenderUrl(params.nodeId);
        const fullText = params.includeTextContent ? await getNodeTextContent(params.nodeId) : null;
        const parents = params.includeParents ? await getNodeParents(params.nodeId) : [];

        // ── JSON output ───────────────────────────────────────────────────
        if (params.outputFormat === 'json') {
          const payload: Record<string, unknown> = {
            ...formatted,
            renderUrl,
          };
          if (params.includeParents) {
            payload['parents'] = parents.map(p => ({
              nodeId: p.ref?.id ?? '',
              title: p.properties?.['cclom:title']?.[0] ?? p.properties?.['cm:name']?.[0] ?? p.name ?? '',
            }));
          }
          if (params.includeTextContent) {
            payload['textContent'] = fullText && fullText.length > 4000
              ? fullText.slice(0, 4000) + '\n[…gekürzt]'
              : (fullText ?? '');
          }
          if (params.includeRaw) {
            payload['raw'] = {
              disciplines: props['ccm:taxonid'] ?? [],
              educationalContexts: props['ccm:educationalcontext'] ?? [],
              userRoles: props['ccm:educationalintendedenduserrole'] ?? [],
              learningResourceTypes: props['ccm:oeh_lrt_aggregated'] ?? [],
              license: props['ccm:commonlicense_key']?.[0] ?? '',
            };
          }
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        // ── Markdown output (default, backward-compat with consumers that parse text) ──
        const lines: string[] = [];
        lines.push(`## ${formatted.title || params.nodeId}`);
        lines.push(`nodeId: ${params.nodeId}`);
        if (formatted.description) lines.push(`Beschreibung: ${formatted.description}`);
        if (formatted.keywords.length) lines.push(`Schlagworte: ${formatted.keywords.join(', ')}`);
        if (formatted.disciplines.length) lines.push(`Fach: ${formatted.disciplines.join(', ')}`);
        if (formatted.educationalContexts.length) lines.push(`Bildungsstufe: ${formatted.educationalContexts.join(', ')}`);
        if (formatted.userRoles.length) lines.push(`Zielgruppe: ${formatted.userRoles.join(', ')}`);
        if (formatted.learningResourceTypes.length) lines.push(`Ressourcentyp: ${formatted.learningResourceTypes.join(', ')}`);
        if (formatted.license) lines.push(`Lizenz: ${formatted.license}`);
        if (formatted.publisher) lines.push(`Anbieter: ${formatted.publisher}`);
        if (formatted.url) lines.push(`URL: ${formatted.url}`);
        if (formatted.previewUrl) lines.push(`Vorschaubild: ${formatted.previewUrl}`);
        lines.push(`WLO-URL: ${renderUrl}`);
        if (formatted.topicPageUrl) lines.push(`Themenseite: ${formatted.topicPageUrl}`);
        lines.push(`Typ: ${formatted.nodeType === 'collection' ? 'Sammlung' : 'Inhalt'}`);

        if (params.includeRaw) {
          lines.push(`\n### Raw URIs`);
          if (props['ccm:taxonid']?.length) lines.push(`Fach-URI: ${props['ccm:taxonid'].join(', ')}`);
          if (props['ccm:educationalcontext']?.length) lines.push(`Bildungsstufe-URI: ${props['ccm:educationalcontext'].join(', ')}`);
          const rawLicense = props['ccm:commonlicense_key']?.[0];
          if (rawLicense) lines.push(`Lizenz-Key: ${rawLicense}`);
        }

        if (params.includeParents) {
          if (parents.length > 0) {
            lines.push(`\n### Eltern-Sammlungen (${parents.length})`);
            for (const p of parents) {
              const pName = (p.properties?.['cclom:title']?.[0] ?? p.properties?.['cm:name']?.[0] ?? p.name ?? p.ref?.id ?? '?');
              const pId = p.ref?.id ?? '?';
              lines.push(`- ${pName} (nodeId: ${pId})`);
            }
          } else {
            lines.push('\nKeine Eltern-Sammlungen gefunden.');
          }
        }

        if (params.includeTextContent) {
          if (fullText) {
            const trimmed = fullText.length > 2000 ? fullText.slice(0, 2000) + '\n[…gekürzt]' : fullText;
            lines.push(`\n### Gespeicherter Volltext`);
            lines.push(trimmed);
          } else {
            lines.push('\nKein gespeicherter Volltext verfügbar.');
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler beim Abruf der Node-Details: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool: search_wlo_all (kombinierte Suche — O1) ─────────────────────────
  // Liefert Einzel-Inhalte + Sammlungen + Themenseiten in EINEM Aufruf, intern
  // PARALLEL. Spart dem Client die separaten Aufrufe von search_wlo_content +
  // search_wlo_collections (= weniger MCP-Round-Trips/Cold-Starts). Themenseiten
  // = Sammlungen mit ccm:page_config_ref → eine Sammlungssuche bedient beide
  // Töpfe, kein separater Themenseiten-Durchlauf nötig. Rückgabe ist ein
  // STRUKTURIERTES Objekt mit getrennten Töpfen (content/collections/topicPages),
  // damit der Client sie direkt in getrennte Anzeige-Bereiche einsortieren kann.
  server.tool(
    'search_wlo_all',
    `Kombinierte WLO-Suche: Einzel-Inhalte (Materialien), Sammlungen UND
Themenseiten in EINEM parallelen Aufruf. Nutze dies statt mehrere
Suchtools nacheinander zu rufen. Liefert ein strukturiertes Objekt mit
getrennten Töpfen { content, collections, topicPages }. Filter akzeptieren
deutsche Labels (z.B. "Mathematik", "Sekundarstufe I", "Video") oder URIs.`,
    {
      query: z.string().describe('Suchbegriff (Deutsch), z.B. "Bruchrechnung Klasse 7"'),
      educationalContext: z.string().optional().describe('Bildungsstufe: "Primarstufe", "Sekundarstufe I", … oder URI'),
      discipline: z.string().optional().describe('Fach: "Mathematik", "Biologie", … oder URI'),
      userRole: z.string().optional().describe('Zielgruppe: "Lehrer/in", "Lerner/in", … oder URI'),
      learningResourceType: z.string().optional().describe('Ressourcentyp: "Arbeitsblatt", "Video", … oder URI'),
      publisher: z.string().optional().describe('Anbieter, z.B. "Klexikon", "Serlo"'),
      maxContent: z.number().int().min(1).max(50).optional().default(8).describe('Max. Einzel-Inhalte (Default 8)'),
      maxCollections: z.number().int().min(1).max(20).optional().default(5).describe('Max. je Sammlungen/Themenseiten (Default 5)'),
      include: z.array(z.enum(['content', 'collections', 'topicPages'])).optional().describe(
        'Welche Töpfe geliefert werden (Default: alle drei).'
      ),
      excludeNodeIds: z.array(z.string()).optional().describe('Bereits gesehene Node-IDs überspringen'),
      outputFormat: z.enum(['json', 'markdown']).optional().default('json').describe(
        '"json" (Default, getrennte Töpfe — für maschinelle Aufteilung) oder "markdown"'
      ),
    },
    async (params) => {
      const query = params.query.trim();
      const want = new Set(params.include ?? ['content', 'collections', 'topicPages']);
      const excluded = new Set(params.excludeNodeIds ?? []);
      const maxContent = params.maxContent ?? 8;
      const maxColl = params.maxCollections ?? 5;
      const { labeled } = buildFilterCriteria(params);
      const { criteria: filters } = buildFilterCriteria(params);

      const EMPTY = { nodes: [] as import('./wlo-api.js').WloNode[], pagination: { total: 0, from: 0, count: 0 } };

      try {
        // O1: Inhalte + Sammlungen PARALLEL. enhancedSearch ist intern bereits
        // varianten-parallel (nach O4 auf max. 5 gedeckelt); die Sammlungssuche
        // ist EIN Keyword-Call (bewusst NICHT der teure Baumlauf — hält die
        // Gesamt-Concurrency niedrig). Wall-Zeit ≈ langsamster der beiden Töpfe.
        const needColl = want.has('collections') || want.has('topicPages');
        const [contentResp, collNodes] = await Promise.all([
          want.has('content')
            ? enhancedSearch(query, 'FILES', filters, maxContent + excluded.size)
            : Promise.resolve(EMPTY),
          needColl
            ? searchCollectionsByKeyword(query, (maxColl + excluded.size) * 2)
            : Promise.resolve([] as import('./wlo-api.js').WloNode[]),
        ]);

        const ok = (id: string) => !!id && !excluded.has(id);

        const contentFmt = formatNodes(contentResp.nodes).filter(n => ok(n.nodeId)).slice(0, maxContent);

        // Sammlungen vs. Themenseiten trennen: topicPageUrl gesetzt ⇒ Themenseite
        // (formatNode leitet das aus ccm:page_config_ref ab).
        // Sammlungen ebenfalls reranken (sonst nur API-Reihenfolge); die
        // Themenseiten (page_config_ref) erben daraus die Relevanz-Ordnung.
        const collAll = formatNodes(rerankNodes(collNodes, query)).filter(n => ok(n.nodeId));
        const topicPagesFmt = want.has('topicPages') ? collAll.filter(n => n.topicPageUrl).slice(0, maxColl) : [];
        const collectionsFmt = want.has('collections') ? collAll.filter(n => !n.topicPageUrl).slice(0, maxColl) : [];

        const metas: { type: 'text'; text: string }[] = [];
        if (want.has('content')) {
          metas.push(queryMetaContent({
            toolName: 'search_wlo_all:content', queryType: 'ngsearch_enhanced', searchTerm: query,
            criteria: [{ property: 'ngsearchword', values: [query] }, ...labeled],
            pagination: { maxItems: maxContent, skipCount: 0, totalResults: contentResp.pagination.total },
            repositoryUrl: WLO_REPOSITORY_URL,
          }));
        }
        if (needColl) {
          metas.push(queryMetaContent({
            toolName: 'search_wlo_all:collections', queryType: 'keyword_collections', searchTerm: query,
            criteria: [{ property: 'ngsearchword', values: [query] }],
            pagination: { maxItems: maxColl, skipCount: 0, totalResults: collAll.length },
            repositoryUrl: WLO_REPOSITORY_URL,
          }));
        }

        const envelope = {
          query,
          content:     { total: contentResp.pagination.total, count: contentFmt.length, results: contentFmt },
          collections: { total: collectionsFmt.length, count: collectionsFmt.length, results: collectionsFmt },
          topicPages:  { total: topicPagesFmt.length, count: topicPagesFmt.length, results: topicPagesFmt },
        };

        if ((params.outputFormat ?? 'json') === 'json') {
          return { content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }, ...metas] };
        }
        const md: string[] = [];
        if (want.has('content'))     { md.push(`# Inhalte (${contentFmt.length})`);          md.push(renderToText(contentFmt, contentResp.pagination.total) || 'Keine Inhalte gefunden.'); }
        if (want.has('collections')) { md.push(`# Sammlungen (${collectionsFmt.length})`);    md.push(renderToText(collectionsFmt) || 'Keine Sammlungen gefunden.'); }
        if (want.has('topicPages'))  { md.push(`# Themenseiten (${topicPagesFmt.length})`);   md.push(renderToText(topicPagesFmt) || 'Keine Themenseiten gefunden.'); }
        return { content: [{ type: 'text' as const, text: md.join('\n\n') }, ...metas] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler bei der kombinierten Suche: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool 6: lookup_wlo_vocabulary ─────────────────────────────────────────
  server.tool(
    'lookup_wlo_vocabulary',
    `Look up available values for WLO filter parameters.
Use this to discover valid labels and URIs for Bildungsstufe (educational context),
Schulfach/Disziplin, Zielgruppe (user role), or Lernressourcentyp (learning resource type).
Useful before calling search tools to find the correct filter values.`,
    {
      vocabulary: z.enum(['educationalContext', 'discipline', 'userRole', 'lrt', 'license', 'targetGroup']).describe(
        'Which vocabulary to list: ' +
        '"educationalContext" (Bildungsstufen), ' +
        '"discipline" (Schulfächer), ' +
        '"userRole" (Zielgruppen), ' +
        '"lrt" (Lernressourcentypen aggregiert), ' +
        '"license" (CC-Lizenzen), ' +
        '"targetGroup" (Themenseiten-Zielgruppen: teacher/learner/general)'
      ),
    },
    async (params) => {
      const vocab = params.vocabulary as VocabKey;
      const entries = listVocab(vocab);

      const vocabNames: Record<VocabKey, string> = {
        educationalContext: 'Bildungsstufe (educationalContext)',
        discipline:         'Schulfach / Disziplin (discipline)',
        userRole:           'Zielgruppe (userRole)',
        lrt:                'Lernressourcentyp aggregiert (lrt)',
        license:            'Lizenzen (license)',
        targetGroup:        'Themenseiten-Zielgruppe (targetGroup)',
      };

      const lines: string[] = [`# Vokabular: ${vocabNames[vocab]}`, ''];
      for (const e of entries) {
        const aliases = e.aliases.length ? ` | Aliases: ${e.aliases.slice(0, 4).join(', ')}` : '';
        lines.push(`- **${e.label}**${aliases}`);
        lines.push(`  URI: ${e.uri}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── Tool 7: search_wlo_topic_pages ──────────────────────────────────────────
  server.tool(
    'search_wlo_topic_pages',
    `Search for Themenseiten (topic pages) on WirLernenOnline.
Themenseiten are curated page layouts with swimlanes, tailored to different target groups
(Lehrkräfte, Lernende, Allgemein). They are linked to Sammlungen (collections).

Three search modes:
1. By collectionId: Direct check whether a specific collection has a Themenseite.
2. By topic (query): Searches collections first, then checks which ones have a Themenseite.
3. By filters only (no query): Lists Themenseiten, optionally filtered by target group or educational context.

Output:
- Each result is titled by its OWNING COLLECTION; if that can't be resolved, the page
  variant's own title (cm:title) is used, never a cryptic "PAGE_VARIANT_xxx" id.
- Multiple variants of the same Themenseite (different target groups) are merged into one entry.
- Target groups are returned as readable labels ("Lehrkräfte"), not slugs.

Order: deterministic. By default sorted alphabetically by collection name with nodeId as tie-breaker.`,
    {
      query: z.string().optional().default('').describe(
        'Thematic search query in German, e.g. "Physik" or "Farben". ' +
        'Searches collections and checks for linked Themenseiten. Leave empty to list all.'
      ),
      targetGroup: z.enum(['teacher', 'learner', 'general']).optional().describe(
        'Target audience: "teacher" (Lehrkräfte), "learner" (Lernende), "general" (Allgemein)'
      ),
      educationalContext: z.string().optional().describe(
        'Educational level: e.g. "Grundschule", "Sekundarstufe I", "Schule", or full URI'
      ),
      collectionId: z.string().optional().describe(
        'Directly check a specific collection (nodeId) for its Themenseite. ' +
        'Bypasses the search – useful when you already have a collection from search_wlo_collections.'
      ),
      mergeVariants: z.boolean().optional().default(true).describe(
        'When true (default), multiple variants of the same Themenseite (different target groups) ' +
        'are merged into a single entry with all variant URLs listed.'
      ),
      sort: z.enum(['relevance', 'alpha']).optional().default('alpha').describe(
        '"alpha" (default, deterministic) sorts by collection name; ' +
        '"relevance" keeps the order returned by the underlying search (only meaningful with a query).'
      ),
      maxResults: z.number().int().min(1).max(20).optional().default(5),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown').describe(
        '"markdown" (default) or "json" (structured)'
      ),
    },
    async (params) => {
      const tg = params.targetGroup as TargetGroup | undefined;
      // Bei Themen-Query default = Relevanz (nutzt das Sammlungs-Reranking);
      // beim reinen Auflisten (Mode C, kein Query) bleibt alphabetisch.
      const sort = params.sort ?? (params.query?.trim() ? 'relevance' : 'alpha');
      const merge = params.mergeVariants !== false;
      let queryType = 'topic_pages';

      try {
        const results: ThemePageInfo[] = [];

        // ── Mode A: Direct collection check ──────────────────────────────────
        if (params.collectionId) {
          queryType = 'topic_pages_by_collection';
          const pages = await getCollectionThemePages(params.collectionId, tg);
          results.push(...pages);
        }
        // ── Mode B: Topic-based search (collection → page_config_ref) ────────
        else if (params.query?.trim()) {
          queryType = 'topic_pages_by_keyword';
          const collections = rerankNodes(await searchCollectionsByKeyword(params.query, 10), params.query);
          for (const coll of collections) {
            const cId = coll.ref?.id;
            if (!cId) continue;
            const pageConfigRef = coll.properties?.['ccm:page_config_ref']?.[0];
            if (!pageConfigRef) continue;
            const pages = await getCollectionThemePages(cId, tg);
            results.push(...pages);
            if (results.length >= (params.maxResults ?? 5) * 3) break;
          }
        }
        // ── Mode C: List all Themenseiten (page_variant API) ─────────────────
        else {
          queryType = 'page_variant';
          const eduCtxUri = params.educationalContext
            ? resolveVocab(params.educationalContext, 'educationalContext') ?? params.educationalContext
            : undefined;
          // Fetch more variants than maxResults so the dedup/merge step still
          // has enough candidates after grouping by collection.
          const variants = await searchPageVariants({
            isTemplate: false,
            targetGroup: tg,
            educationalContext: eduCtxUri,
          }, Math.max(50, (params.maxResults ?? 5) * 5));

          // Resolve owning collections so each result has a human-readable
          // title. Perf: a per-batch cache dedupes the owner-resolution and
          // owner-metadata fetches across sibling variants of the same
          // Themenseite; the variant's known primary parent
          // (virtual:primaryparent_nodeid) skips a round-trip; and a bounded
          // pool caps concurrent upstream fetches.
          const parentCache = new Map<string, { id: string; name: string } | null>();
          const ownerMetaCache = new Map<string, Promise<WloNode | null>>();
          const stripWs = (s?: string) => (s ?? '').replace('workspace://SpacesStore/', '');

          const enriched = await mapPool(variants, 10, async (v) => {
            const vProps = v.properties ?? {};
            const variantId = v.ref?.id ?? '';
            if (!variantId) return null;
            const knownParentId = stripWs(vProps['virtual:primaryparent_nodeid']?.[0]) || undefined;
            const owner = await resolveVariantCollection(variantId, parentCache, knownParentId);
            let ownerNode: WloNode | null = null;
            if (owner) {
              if (!ownerMetaCache.has(owner.id)) ownerMetaCache.set(owner.id, getNodeMetadata(owner.id));
              ownerNode = await ownerMetaCache.get(owner.id)!;
            }
            const ownerProps = ownerNode?.properties ?? {};
            const pageConfigRef = ownerProps['ccm:page_config_ref']?.[0];
            const topicPageUrl = owner ? buildTopicPageUrl(owner.id, pageConfigRef) ?? '' : '';

            return {
              variantId,
              variantName: vProps['cm:name']?.[0] || v.name || '',
              variantTitle: vProps['cclom:title']?.[0] || vProps['cm:title']?.[0] || '',
              targetGroup: vProps['ccm:page_variant_profiling_target_group']?.[0] || '',
              educationalContexts: vProps['ccm:educationalcontext'] ?? [],
              isTemplate: false,
              topicPageUrl,
              collectionId: owner?.id,
              collectionName: owner?.name,
            } satisfies ThemePageInfo;
          });

          for (const r of enriched) {
            if (r) results.push(r);
          }
        }

        if (results.length === 0) {
          const hint = params.query
            ? `Keine Themenseiten für "${params.query}" gefunden. Die Sammlung hat möglicherweise keine konfigurierte Themenseite (ccm:page_config_ref fehlt).`
            : 'Keine Themenseiten gefunden.';
          return { content: [{ type: 'text', text: hint }] };
        }

        // Build "presented" entries: optionally merge variants of the same
        // collection into one entry, resolve target-group/edu-context labels.
        type Variant = { variantId: string; targetGroup: string; targetGroupLabel: string; topicPageUrl: string };
        type Presented = {
          title: string;
          collectionId: string;
          variants: Variant[];
          educationalContexts: string[];
          topicPageUrl: string;
        };

        const seen = new Map<string, Presented>();
        const order: string[] = [];

        for (const r of results) {
          const collectionId = r.collectionId ?? r.variantId;
          // Never surface the raw "PAGE_VARIANT_<uuid>" (cm:name) or a bare
          // node UUID. Prefer owning-collection name → variant cm:title →
          // clean cm:name → generic "Themenseite".
          const title = pickThemePageTitle(r);
          const eduLabels = r.educationalContexts.map(u => labelFromUri(u, 'educationalContext'));
          const tgLabel = r.targetGroup ? labelFromUri(r.targetGroup, 'targetGroup') : 'nicht gesetzt';
          const variant: Variant = {
            variantId: r.variantId,
            targetGroup: r.targetGroup || '',
            targetGroupLabel: tgLabel,
            topicPageUrl: r.topicPageUrl,
          };

          const key = merge ? collectionId : r.variantId;
          if (seen.has(key)) {
            const ex = seen.get(key)!;
            if (!ex.variants.some(v => v.variantId === variant.variantId)) ex.variants.push(variant);
            for (const e of eduLabels) if (!ex.educationalContexts.includes(e)) ex.educationalContexts.push(e);
            if (!ex.topicPageUrl && variant.topicPageUrl) ex.topicPageUrl = variant.topicPageUrl;
          } else {
            seen.set(key, {
              title,
              collectionId,
              variants: [variant],
              educationalContexts: eduLabels,
              topicPageUrl: r.topicPageUrl,
            });
            order.push(key);
          }
        }

        // Stable, deterministic ordering:
        // - relevance: keep insertion order (tie-broken by collectionId)
        // - alpha: sort by title (with collectionId tie-breaker)
        const sortedKeys = sort === 'alpha'
          ? [...order].sort((a, b) => {
              const ta = (seen.get(a)?.title ?? '').toLowerCase();
              const tb = (seen.get(b)?.title ?? '').toLowerCase();
              if (ta !== tb) return ta.localeCompare(tb, 'de');
              return a.localeCompare(b);
            })
          : [...order].sort((a, b) => {
              // relevance: keep insertion order — tie-break alphabetically only
              // when two entries appeared at the same position (rare).
              return order.indexOf(a) - order.indexOf(b);
            });

        const out = sortedKeys.slice(0, params.maxResults ?? 5).map(k => seen.get(k)!);

        const tpCriteria: LabeledCriterion[] = [];
        if (params.query?.trim()) tpCriteria.push({ property: 'ngsearchword', values: [params.query] });
        if (params.collectionId) tpCriteria.push({ property: 'collectionId', values: [params.collectionId] });
        if (params.targetGroup) {
          const tgLabel = labelFromUri(params.targetGroup, 'targetGroup');
          tpCriteria.push({ property: 'targetGroup', values: [params.targetGroup], label: tgLabel });
        }
        if (params.educationalContext) {
          const eduUri = resolveVocab(params.educationalContext, 'educationalContext') ?? params.educationalContext;
          tpCriteria.push({ property: 'ccm:educationalcontext', values: [eduUri], label: params.educationalContext });
        }
        const tpMeta = queryMetaContent({
          toolName: 'search_wlo_topic_pages',
          queryType,
          searchTerm: params.query ?? '',
          criteria: tpCriteria,
          pagination: { maxItems: params.maxResults ?? 5, skipCount: 0, totalResults: out.length },
          repositoryUrl: WLO_REPOSITORY_URL,
        });

        // ── JSON output ───────────────────────────────────────────────────
        if (params.outputFormat === 'json') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                total: out.length,
                results: out,
              }, null, 2),
            }, tpMeta],
          };
        }

        // ── Markdown output ───────────────────────────────────────────────
        const lines: string[] = [`Gefundene Themenseiten: ${out.length}\n`];
        for (const r of out) {
          const parts: string[] = [];
          parts.push(`## ${r.title}`);
          parts.push(`Sammlung-nodeId: ${r.collectionId}`);
          if (r.educationalContexts.length) {
            parts.push(`Bildungsstufe: ${r.educationalContexts.join(', ')}`);
          }
          if (r.topicPageUrl) parts.push(`Themenseite: ${r.topicPageUrl}`);
          if (r.variants.length === 1) {
            parts.push(`Zielgruppe: ${r.variants[0].targetGroupLabel}`);
            parts.push(`Variante-ID: ${r.variants[0].variantId}`);
          } else {
            parts.push(`Varianten (${r.variants.length}):`);
            for (const v of r.variants) {
              parts.push(`  - ${v.targetGroupLabel} (Variante-ID: ${v.variantId})`);
            }
          }
          lines.push(parts.join('\n'));
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n').trim() }, tpMeta] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler bei der Themenseiten-Suche: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool 8: get_subject_portals (Fachportale) ──────────────────────────────
  server.tool(
    'get_subject_portals',
    `Lists the WLO Fachportale — the first-level Sammlungen directly under the WLO root collection.
Fachportale are the top-level subject hubs (Mathematik, Informatik, Deutsch, …) that anchor the
content tree. Each portal has an associated Themenseite when ccm:page_config_ref is set.

Use this when the user wants an overview of what subjects/topics are covered, or as the natural
entry point for guided drill-downs ("Zeig mir Mathe" → portal → sub-Sammlungen → Inhalte).

Returns deterministic alphabetical ordering, with portal nodeId, name, description, optional
Themenseiten-URL, and the disciplines/educational contexts associated with the portal.`,
    {
      educationalContext: z.string().optional().describe(
        'Filter by educational level (e.g. "Sekundarstufe I"). Most portals span multiple levels — '+
        'the filter only excludes portals where the level is explicitly different.'
      ),
      includeContentCounts: z.boolean().optional().default(false).describe(
        'When true, also fetch the number of direct sub-collections per portal (extra round-trip).'
      ),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown'),
    },
    async (params) => {
      try {
        const portals = await getChildCollections(WLO_ROOT_COLLECTION_ID, 100);

        // Optional educational-context filter
        let filtered = portals;
        if (params.educationalContext) {
          const wantedUri = resolveVocab(params.educationalContext, 'educationalContext');
          if (wantedUri) {
            filtered = portals.filter(p => {
              const ec = p.properties?.['ccm:educationalcontext'] ?? [];
              // Keep portals that don't specify a context (apply to all) OR match.
              return ec.length === 0 || ec.includes(wantedUri);
            });
          }
        }

        // Deterministic alphabetical sort
        const sorted = sortByTitle(filtered);

        // Optional content-count enrichment
        const counts: Record<string, number> = {};
        if (params.includeContentCounts) {
          await Promise.allSettled(sorted.map(async p => {
            const id = p.ref?.id;
            if (!id) return;
            const subs = await getChildCollections(id, 100);
            counts[id] = subs.length;
          }));
        }

        const formatted = sorted.map(p => {
          const f = formatNode(p);
          return {
            ...f,
            subCollectionCount: params.includeContentCounts ? (counts[f.nodeId] ?? 0) : undefined,
          };
        });

        if (params.outputFormat === 'json') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ total: formatted.length, results: formatted }, null, 2),
            }],
          };
        }

        const lines: string[] = [`WLO Fachportale: ${formatted.length}\n`];
        for (const p of formatted) {
          const parts: string[] = [];
          parts.push(`## ${p.title}`);
          parts.push(`nodeId: ${p.nodeId}`);
          if (p.description) parts.push(`Beschreibung: ${p.description.slice(0, 300)}${p.description.length > 300 ? '…' : ''}`);
          if (p.disciplines.length) parts.push(`Fach: ${p.disciplines.join(', ')}`);
          if (p.educationalContexts.length) parts.push(`Bildungsstufe: ${p.educationalContexts.join(', ')}`);
          if (p.topicPageUrl) parts.push(`Themenseite: ${p.topicPageUrl}`);
          if (p.subCollectionCount !== undefined) parts.push(`Sub-Sammlungen: ${p.subCollectionCount}`);
          lines.push(parts.join('\n'));
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n').trim() }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler beim Abruf der Fachportale: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool 9: browse_collection_tree ─────────────────────────────────────────
  server.tool(
    'browse_collection_tree',
    `Drill into the sub-collection tree below a given collection.
Returns the direct sub-Sammlungen at \`depth=1\` (default) or two levels at \`depth=2\`.
Optionally enriches each node with the count of files (Lernmaterialien) it contains.

Use this for guided exploration: pick a Fachportal or Themenseite, then let the user
choose a sub-area before fetching individual content items. Output is deterministic
(alphabetical by name, nodeId tie-breaker).`,
    {
      nodeId: z.string().describe('Parent collection nodeId. Use a Fachportal nodeId from get_subject_portals as a starting point.'),
      depth: z.number().int().min(1).max(2).optional().default(1).describe(
        '1 = direct sub-collections only (fast); 2 = also include grand-children (more API calls).'
      ),
      includeContentCounts: z.boolean().optional().default(false).describe(
        'When true, fetch the number of files (Inhalte) inside each sub-collection (extra round-trip per node).'
      ),
      maxResults: z.number().int().min(1).max(100).optional().default(50),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown'),
    },
    async (params) => {
      const depth = params.depth ?? 1;

      try {
        const level1 = await getChildCollections(params.nodeId, params.maxResults ?? 50);
        const sorted1 = sortByTitle(level1);

        type TreeNode = ReturnType<typeof formatNode> & {
          fileCount?: number;
          children?: TreeNode[];
        };

        const enrichOne = async (n: WloNode): Promise<TreeNode> => {
          const f = formatNode(n) as TreeNode;
          if (params.includeContentCounts) {
            const id = n.ref?.id;
            if (id) {
              const filesResp = await getCollectionContents(id, 'files', 1, 0);
              f.fileCount = filesResp.pagination.total;
            }
          }
          if (depth === 2) {
            const id = n.ref?.id;
            if (id) {
              const children = await getChildCollections(id, 30);
              const sortedChildren = sortByTitle(children);
              f.children = await Promise.all(sortedChildren.map(c => enrichOne(c)));
            }
          }
          return f;
        };

        const tree = await Promise.all(sorted1.map(n => enrichOne(n)));

        if (params.outputFormat === 'json') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ parent: params.nodeId, depth, total: tree.length, results: tree }, null, 2),
            }],
          };
        }

        const lines: string[] = [`Sub-Sammlungen unter ${params.nodeId}: ${tree.length} (Tiefe ${depth})\n`];
        const renderTree = (nodes: TreeNode[], indent: number) => {
          for (const n of nodes) {
            const pad = '  '.repeat(indent);
            const cnt = n.fileCount !== undefined ? ` [${n.fileCount} Inhalte]` : '';
            lines.push(`${pad}- **${n.title}** (${n.nodeId})${cnt}`);
            if (n.children?.length) renderTree(n.children, indent + 1);
          }
        };
        renderTree(tree, 0);
        return { content: [{ type: 'text', text: lines.join('\n').trim() }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler beim Sub-Sammlungs-Abruf: ${msg}` }], isError: true };
      }
    },
  );

  // ── Tool 10: wlo_health_check ─────────────────────────────────────────────
  server.tool(
    'wlo_health_check',
    `Probe whether the WLO repository API is reachable and responding.
Returns latency in ms, the resolved root collection nodeId, and a status flag.
Useful for callers (e.g. chatbots) to quickly tell "WLO is down" from "your query produced no hits".`,
    {},
    async () => {
      const t0 = Date.now();
      try {
        const root = WLO_ROOT_COLLECTION_ID;
        const node = await getNodeMetadata(root);
        const latencyMs = Date.now() - t0;
        const ok = node !== null;
        const payload = {
          ok,
          repositoryUrl: WLO_REPOSITORY_URL,
          baseUrl: BASE_URL,
          rootNodeId: root,
          rootResolved: ok ? (node.properties?.['cclom:title']?.[0] ?? node.properties?.['cm:name']?.[0] ?? null) : null,
          latencyMs,
          checkedAt: new Date().toISOString(),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const payload = {
          ok: false,
          repositoryUrl: WLO_REPOSITORY_URL,
          baseUrl: BASE_URL,
          error: msg,
          latencyMs: Date.now() - t0,
          checkedAt: new Date().toISOString(),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
      }
    },
  );

  // ── Tool 11: get_nodes_details (Bulk metadata) ─────────────────────────────
  server.tool(
    'get_nodes_details',
    `Bulk-fetch metadata for multiple node IDs in parallel.
Saves N round-trips when callers need details for many nodes (e.g. resolve cards from a search).
Returns the same FormattedNode shape as get_node_details (json mode), keyed by nodeId.

Failed lookups (deleted node, network error) are returned in the \`failed\` array, not as
overall errors — so a single bad nodeId doesn't ruin the whole batch.`,
    {
      nodeIds: z.array(z.string()).min(1).max(50).describe(
        'Array of node IDs to fetch (max 50 per call).'
      ),
    },
    async (params) => {
      const ids = Array.from(new Set(params.nodeIds.filter(Boolean)));
      const settled = await Promise.allSettled(ids.map(id => getNodeMetadata(id)));
      const results: Record<string, ReturnType<typeof formatNode>> = {};
      const failed: string[] = [];
      ids.forEach((id, i) => {
        const r = settled[i];
        if (r.status === 'fulfilled' && r.value) {
          results[id] = formatNode(r.value);
        } else {
          failed.push(id);
        }
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            requested: ids.length,
            resolved: Object.keys(results).length,
            failed,
            results,
          }, null, 2),
        }],
      };
    },
  );

  // ── Tool 12: get_topic_page_content ──────────────────────────────────────────
  server.tool(
    'get_topic_page_content',
    `Get the CONTENT STRUCTURE of a Themenseite (topic page): its sections
(swimlanes) — each with a heading and the nodeIds of the materials/collections
embedded in it. Use this AFTER search_wlo_topic_pages to see what is actually ON
a topic page (search_wlo_topic_pages only returns its URL). Resolve the returned
nodeIds to human titles with get_nodes_details.

Provide EITHER variantId (a "Variante-ID" from search_wlo_topic_pages — fastest)
OR collectionId (a "Sammlung-nodeId"). At least one is required.`,
    {
      collectionId: z.string().optional().describe(
        'Owning collection nodeId of the Themenseite (the "Sammlung-nodeId" from search_wlo_topic_pages).'
      ),
      variantId: z.string().optional().describe(
        'A specific page-variant nodeId (the "Variante-ID" from search_wlo_topic_pages). Faster than collectionId.'
      ),
      targetGroup: z.enum(['teacher', 'learner', 'general']).optional().describe(
        'When resolving by collectionId, pick the variant for this target group.'
      ),
      outputFormat: z.enum(['markdown', 'json']).optional().default('markdown').describe(
        '"markdown" (default) or "json" (structured: swimlanes[] + referencedNodeIds[])'
      ),
    },
    async (params) => {
      try {
        if (!params.collectionId && !params.variantId) {
          return { content: [{ type: 'text', text: 'Bitte collectionId oder variantId angeben.' }], isError: true };
        }
        const struct = await getTopicPageContent({
          collectionId: params.collectionId,
          variantId: params.variantId,
          targetGroup: params.targetGroup as TargetGroup | undefined,
        });
        if (!struct || struct.swimlanes.length === 0) {
          return { content: [{ type: 'text', text: 'Keine Themenseiten-Inhaltsstruktur gefunden (keine Variante oder leere Konfiguration).' }] };
        }

        if (params.outputFormat === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(struct, null, 2) }] };
        }

        const lines: string[] = [];
        if (struct.variantTitle) lines.push(`# ${struct.variantTitle}`);
        lines.push(`Abschnitte (Swimlanes): ${struct.swimlanes.length}`);
        lines.push('');
        struct.swimlanes.forEach((sl, i) => {
          lines.push(`## ${i + 1}. ${sl.heading || '(ohne Überschrift)'}${sl.type ? ` [${sl.type}]` : ''}`);
          for (const it of sl.items) {
            lines.push(`  - ${it.widget || 'widget'}${it.nodeId ? ` → nodeId: ${it.nodeId}` : ''}`);
          }
        });
        if (struct.referencedNodeIds.length) {
          lines.push('');
          lines.push(`Eingebettete nodeIds (${struct.referencedNodeIds.length}): ${struct.referencedNodeIds.join(', ')}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler beim Abruf des Themenseiten-Inhalts: ${msg}` }], isError: true };
      }
    },
  );

  return server;
}
