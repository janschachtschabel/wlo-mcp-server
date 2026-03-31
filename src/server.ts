/**
 * server.ts – MCP Server factory with all WLO tools registered.
 * Transport-agnostic: connect stdio or Streamable HTTP outside this file.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { WloEnvironment, SearchCriterion } from './wlo-api.js';
import { ngsearch, searchCollectionsByKeyword, getCollectionContents, getChildCollections, getNodeMetadata, getNodeTextContent, getNodeParents, fetchWebContent, WEB_CONTENT_WHITELIST, WLO_ROOT_COLLECTION_IDS, searchPageVariants, getCollectionThemePages, buildTopicPageUrl } from './wlo-api.js';
import type { TargetGroup, ThemePageInfo } from './wlo-api.js';
import { enhancedSearch, rerankNodes } from './reranker.js';
import { formatNodes, renderToText, setFormatEnvironment } from './formatter.js';
import { resolveVocab, listVocab, labelFromUri, type VocabKey } from './vocabs.js';

// ── Shared filter builder ────────────────────────────────────────────────────

function buildFilterCriteria(params: {
  educationalContext?: string;
  discipline?: string;
  userRole?: string;
  publisher?: string;
  learningResourceType?: string;
}): SearchCriterion[] {
  const criteria: SearchCriterion[] = [];

  if (params.educationalContext) {
    const uri = resolveVocab(params.educationalContext, 'educationalContext');
    if (uri) criteria.push({ property: 'ccm:educationalcontext', values: [uri] });
  }
  if (params.discipline) {
    const uri = resolveVocab(params.discipline, 'discipline');
    if (uri) criteria.push({ property: 'ccm:taxonid', values: [uri] });
  }
  if (params.userRole) {
    const uri = resolveVocab(params.userRole, 'userRole');
    if (uri) criteria.push({ property: 'ccm:educationalintendedenduserrole', values: [uri] });
  }
  if (params.publisher) {
    criteria.push({ property: 'ccm:oeh_publisher_combined', values: [params.publisher] });
  }
  const lrt = resolveVocab(params.learningResourceType ?? '', 'lrt');
  if (lrt) criteria.push({ property: 'ccm:oeh_lrt_aggregated', values: [lrt] });

  return criteria;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  const defaultEnv = (process.env['WLO_ENV'] ?? 'production') as WloEnvironment;

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
      maxResults: z.number().int().min(1).max(20).optional().default(5).describe(
        'Maximum number of results (1–20, default 5)'
      ),
      environment: z.enum(['production', 'staging']).optional().describe(
        'WLO environment: "production" (default) or "staging"'
      ),
    },
    async (params) => {
      const env: WloEnvironment = params.environment ?? defaultEnv;
      setFormatEnvironment(env);
      const maxResults = params.maxResults ?? 5;

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

      try {
        const query    = params.query.trim();
        // Use parentNodeId if given, otherwise start from WLO root
        const startId  = params.parentNodeId ?? WLO_ROOT_COLLECTION_IDS[env];

        // ── Primary: full-text search via contentType=COLLECTIONS ─────────────
        // Only use for root-level search (no parentNodeId) so guided traversal
        // still works correctly when the client restricts to a subtree.
        if (query && !params.parentNodeId) {
          const directHits = await searchCollectionsByKeyword(env, query, maxResults);
          if (directHits.length > 0) {
            const formatted = formatNodes(directHits);
            const text = renderToText(formatted, directHits.length);
            return { content: [{ type: 'text', text }] };
          }
        }

        // ── Fallback: children-traversal (used when parentNodeId given or direct search empty) ──
        const level1 = await getChildCollections(env, startId, 100);

        if (!query) {
          const formatted = formatNodes(level1.slice(0, maxResults));
          const text = renderToText(formatted, level1.length);
          return { content: [{ type: 'text', text: text || 'Keine Sammlungen gefunden.' }] };
        }

        // Level-1: filter direct children by keyword
        let matches = level1.filter(n => matchesQuery(n, query));

        // Level-2 fallback: go one level deeper across all level-1 children
        const level2Results = await Promise.allSettled(
          level1.map(parent => getChildCollections(env, parent.ref?.id ?? '', 50))
        );
        const allLevel2Nodes: import('./wlo-api.js').WloNode[] = [];
        for (const r of level2Results) {
          if (r.status === 'fulfilled') {
            allLevel2Nodes.push(...r.value);
            matches.push(...r.value.filter(n => matchesQuery(n, query)));
          }
        }

        if (matches.length === 0) {
          // Level-3 fallback: sort Level-2 nodes by query-word relevance,
          // then fetch children of the top 15 most relevant Level-2 nodes
          const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const scoreNode = (n: import('./wlo-api.js').WloNode): number => {
            const text = [
              n.properties?.['cm:name']?.[0] ?? '',
              n.properties?.['cclom:title']?.[0] ?? '',
              n.properties?.['cclom:general_description']?.[0] ?? '',
            ].join(' ').toLowerCase();
            return queryWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
          };
          // If any nodes score > 0, put them first; otherwise keep natural tree order
          const anyScored = allLevel2Nodes.some(n => scoreNode(n) > 0);
          const level2Candidates = anyScored
            ? [...allLevel2Nodes].sort((a, b) => scoreNode(b) - scoreNode(a)).slice(0, 30)
            : allLevel2Nodes.slice(0, 30);

          const level3Results = await Promise.allSettled(
            level2Candidates.map(parent => getChildCollections(env, parent.ref?.id ?? '', 30))
          );
          for (const r of level3Results) {
            if (r.status === 'fulfilled') matches.push(...r.value.filter(n => matchesQuery(n, query)));
          }
        }

        if (matches.length === 0) {
          return { content: [{ type: 'text', text: `Keine Sammlungen gefunden für "${query}". Versuche einen übergeordneten Begriff (z.B. "Mathematik" statt "Bruchrechnung") oder frag nach verfügbaren Sammlungen ohne Suchbegriff.` }] };
        }

        const formatted = formatNodes(matches.slice(0, maxResults));
        const text = renderToText(formatted, matches.length);
        return { content: [{ type: 'text', text: text || 'Keine Sammlungen gefunden.' }] };
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
      maxResults: z.number().int().min(1).max(20).optional().default(8).describe(
        'Maximum number of results (1–20, default 8)'
      ),
      environment: z.enum(['production', 'staging']).optional().describe(
        'WLO environment: "production" (default) or "staging"'
      ),
    },
    async (params) => {
      const env: WloEnvironment = params.environment ?? defaultEnv;
      setFormatEnvironment(env);
      const filters = buildFilterCriteria(params);
      const maxResults = params.maxResults ?? 8;

      try {
        let response;
        if (params.query.trim()) {
          response = await enhancedSearch(env, params.query, 'FILES', filters, maxResults);
        } else {
          const browseCriteria: SearchCriterion[] = filters.length
            ? filters
            : [{ property: 'ngsearchword', values: ['*'] }];
          response = await ngsearch(env, browseCriteria, 'FILES', maxResults);
        }

        const formatted = formatNodes(response.nodes);
        const text = renderToText(formatted, response.pagination.total);
        return { content: [{ type: 'text', text: text || 'Keine Inhalte gefunden.' }] };
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
      environment: z.enum(['production', 'staging']).optional().describe(
        'WLO environment: "production" (default) or "staging"'
      ),
    },
    async (params) => {
      const env: WloEnvironment = params.environment ?? defaultEnv;
      setFormatEnvironment(env);
      const filter = (params.contentFilter ?? 'files') as 'files' | 'folders' | 'both';
      const maxResults = params.maxResults ?? 20;
      const skipCount = params.skipCount ?? 0;

      try {
        let allNodes: ReturnType<typeof formatNodes>[0][] = [];
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
            const filesResp = await getCollectionContents(env, cid, 'files', 50);
            totalHits += filesResp.pagination.total;
            let fileNodes = filesResp.nodes;
            if (params.query?.trim()) fileNodes = rerankNodes(fileNodes, params.query);
            allNodes.push(...formatNodes(fileNodes));

            // Fetch sub-collections and queue them
            const subs = await getChildCollections(env, cid);
            for (const sub of subs) {
              const subId = sub.ref?.id ?? sub.properties?.['sys:node-uuid']?.[0];
              if (subId && !visited.has(subId)) collectionQueue.push(subId);
            }
          }
          allNodes = allNodes.slice(0, maxResults);
        } else {
          const response = await getCollectionContents(env, params.nodeId, filter, maxResults, skipCount);
          totalHits = response.pagination.total;
          let nodes = response.nodes;
          if (params.query?.trim() && filter !== 'folders') {
            nodes = rerankNodes(nodes, params.query);
          }
          allNodes = formatNodes(nodes.slice(0, maxResults));
        }

        const text = renderToText(allNodes, totalHits);
        return { content: [{ type: 'text', text: text || 'Sammlung ist leer oder nodeId nicht gefunden.' }] };
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
- Metadata: title, description, keywords, subject, educational level, license, publisher, URL
- textContent: the crawled/stored full text of the linked web page or document (when available)
- parents: the collection(s) this node belongs to (useful to find which Sammlung a content item is in)`,
    {
      nodeId: z.string().describe('Node ID of a content item or collection (from search results)'),
      includeTextContent: z.boolean().optional().default(false).describe(
        'Also fetch the stored full-text content of the node (crawled webpage/PDF text)'
      ),
      includeParents: z.boolean().optional().default(false).describe(
        'Also fetch the parent collections this node belongs to'
      ),
      environment: z.enum(['production', 'staging']).optional().describe(
        'WLO environment: "production" (default) or "staging"'
      ),
    },
    async (params) => {
      const env: WloEnvironment = params.environment ?? defaultEnv;

      try {
        const node = await getNodeMetadata(env, params.nodeId);
        if (!node) {
          return { content: [{ type: 'text', text: `Node ${params.nodeId} nicht gefunden.` }] };
        }

        const props = node.properties ?? {};
        const lines: string[] = [];

        const title = (props['cclom:title']?.[0] ?? props['cm:name']?.[0] ?? params.nodeId);
        lines.push(`## ${title}`);
        lines.push(`nodeId: ${params.nodeId}`);

        const desc = props['cclom:general_description']?.[0];
        if (desc) lines.push(`Beschreibung: ${desc}`);

        const keywords = props['cclom:general_keyword'];
        if (keywords?.length) lines.push(`Schlagworte: ${keywords.join(', ')}`);

        const subject = props['ccm:taxonid'];
        if (subject?.length) lines.push(`Fach-URI: ${subject.join(', ')}`);

        const eduCtx = props['ccm:educationalcontext'];
        if (eduCtx?.length) lines.push(`Bildungsstufe-URI: ${eduCtx.join(', ')}`);

        const license = props['ccm:commonlicense_key']?.[0];
        if (license) lines.push(`Lizenz: ${license}`);

        const publisher = props['ccm:oeh_publisher_combined']?.[0] ?? props['ccm:metadatacontributer_publisher']?.[0];
        if (publisher) lines.push(`Anbieter: ${publisher}`);

        const url = props['ccm:wwwurl']?.[0] ?? props['cclom:location']?.[0];
        if (url && !url.startsWith('ccrep://')) lines.push(`URL: ${url}`);

        const renderUrl = `https://redaktion.openeduhub.net/edu-sharing/components/render/${params.nodeId}`;
        lines.push(`WLO-URL: ${renderUrl}`);

        const pageConfigRef = props['ccm:page_config_ref']?.[0];
        const topicPageUrl = buildTopicPageUrl(env, params.nodeId, pageConfigRef);
        if (topicPageUrl) lines.push(`Themenseite: ${topicPageUrl}`);

        const nodeType = props['cm:objecttype']?.[0];
        if (nodeType) lines.push(`Typ: ${nodeType}`);

        if (params.includeParents) {
          const parents = await getNodeParents(env, params.nodeId);
          if (parents.length > 0) {
            lines.push(`\n### Eltern-Sammlungen (${parents.length})`);
            for (const p of parents) {
              const pName = (p.properties?.['cm:name']?.[0] ?? p.name ?? p.ref?.id ?? '?');
              const pId = p.ref?.id ?? '?';
              lines.push(`- ${pName} (nodeId: ${pId})`);
            }
          } else {
            lines.push('\nKeine Eltern-Sammlungen gefunden.');
          }
        }

        if (params.includeTextContent) {
          const text = await getNodeTextContent(env, params.nodeId);
          if (text) {
            const trimmed = text.length > 2000 ? text.slice(0, 2000) + '\n[…gekürzt]' : text;
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

  // ── Helper for web tools ─────────────────────────────────────────────────
  const makeWebTool = (base: string) => async (params: { path?: string; maxLength?: number }) => {
    try {
      const url = base + (params.path ?? '');
      const raw = await fetchWebContent(url);
      const limit = params.maxLength ?? 8000;
      const trimmed = raw.length > limit
        ? raw.slice(0, limit) + `\n\n[…abgeschnitten. Unterseite wählen oder maxLength erhöhen.]`
        : raw;
      return { content: [{ type: 'text' as const, text: trimmed || 'Kein Inhalt extrahiert.' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Fehler: ${msg}` }], isError: true };
    }
  };
  const webParams = {
    path: z.string().optional().describe(
      'Optional subpage path, e.g. "/fachportale/informatik". Leave empty for the main page.'
    ),
    maxLength: z.number().int().min(500).max(20000).optional().default(8000).describe(
      'Maximum characters to return (default 8000)'
    ),
  };

  const webNav = `
Multi-level exploration strategy (up to 5 levels):
1. Call this tool without a path to fetch the main page and discover navigation links.
2. Identify the ONE most relevant link for the user's question.
3. Call this tool again with that path to get the subpage content.
4. Repeat steps 2–3 up to 5 levels total until you have enough information to answer.
Only follow ONE link per level – do not fetch multiple pages at the same depth.`;

  // ── Tool 5a: get_wirlernenonline_info ────────────────────────────────────
  server.tool(
    'get_wirlernenonline_info',
    `Fetch information from WirLernenOnline (WLO) – the German OER portal website.
Use this tool when the user asks about: WirLernenOnline, WLO, OER, OER-Statistik, Fachportale,
Qualitätssicherung, Quellenerschließung, WLO Plug-ins, Mitmachen, Fachredaktion,
or portal/subject names like Informatik, Deutsch, Medienbildung, Zeitgemäße Bildung,
Nachhaltigkeit, ComeIn.
Base URL: https://www.wirlernenonline.de
${webNav}`,
    webParams,
    makeWebTool('https://www.wirlernenonline.de'),
  );

  // ── Tool 5b: get_edu_sharing_network_info ────────────────────────────────
  server.tool(
    'get_edu_sharing_network_info',
    `Fetch information from edu-sharing-network.org – the edu-sharing community and network site.
Use this tool when the user asks about: edu-sharing Vernetzung, Bildungscloud, offene Bildung,
Community, open source, E-Learning, or project/event names like ITsJOINTLY, JOINTLY, BIRD,
Bildungsraum Digital, OER-Statistik, OER- & IT-Sommercamp, Hackathon,
Hackathons für OER-Softwarelösungen, WirLernenOnline (Projektkontext).
Base URL: https://edu-sharing-network.org
${webNav}`,
    webParams,
    makeWebTool('https://edu-sharing-network.org'),
  );

  // ── Tool 5c: get_edu_sharing_product_info ───────────────────────────────
  server.tool(
    'get_edu_sharing_product_info',
    `Fetch information from edu-sharing.com – the edu-sharing software product website.
Use this tool when the user asks about: edu-sharing, Open Source, Bildungscloud,
Enterprise Suchmaschine, Suchmaschine, E-Learning Cloudspeicher, Repository,
Portal für Bildungsmedien, Cloudspeicher, Tools & Plugins, Architektur & Integration,
Dokumentation, Downloads, Moodle Integration, App, Demo.
Base URL: https://edu-sharing.com
${webNav}`,
    webParams,
    makeWebTool('https://edu-sharing.com'),
  );

  // ── Tool 5d: get_metaventis_info ─────────────────────────────────────────
  server.tool(
    'get_metaventis_info',
    `Fetch information from metaventis.com – the metaVentis company website (edu-sharing core dev team).
Use this tool when the user asks about: metaVentis, edu-sharing Kern-Entwicklerteam,
Landes-Schulcloud, OER auf Landesebene, IDM Landeskonzepte, Autoren- & Redaktions-Lösung,
IT-Partner für F&E-Projekte, Firmenwissen und E-Learning integriert.
Base URL: https://metaventis.com
${webNav}`,
    webParams,
    makeWebTool('https://metaventis.com'),
  );

  // ── Tool 6: lookup_wlo_vocabulary ─────────────────────────────────────────
  server.tool(
    'lookup_wlo_vocabulary',
    `Look up available values for WLO filter parameters.
Use this to discover valid labels and URIs for Bildungsstufe (educational context),
Schulfach/Disziplin, Zielgruppe (user role), or Lernressourcentyp (learning resource type).
Useful before calling search tools to find the correct filter values.`,
    {
      vocabulary: z.enum(['educationalContext', 'discipline', 'userRole', 'lrt']).describe(
        'Which vocabulary to list: ' +
        '"educationalContext" (Bildungsstufen), ' +
        '"discipline" (Schulfächer), ' +
        '"userRole" (Zielgruppen), ' +
        '"lrt" (Lernressourcentypen aggregiert)'
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

Two search modes:
1. By topic (query): Searches collections first, then checks which ones have a Themenseite.
2. By filters only: Lists all available Themenseiten, optionally filtered by target group or educational context.

Returns the topic-page URL that can be opened directly in the browser.`,
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
      maxResults: z.number().int().min(1).max(20).optional().default(5),
      environment: z.enum(['production', 'staging']).optional().describe(
        'WLO environment: "production" (default) or "staging"'
      ),
    },
    async (params) => {
      const env: WloEnvironment = params.environment ?? defaultEnv;
      const tg = params.targetGroup as TargetGroup | undefined;

      try {
        const results: ThemePageInfo[] = [];

        // ── Mode A: Direct collection check ──────────────────────────────────
        if (params.collectionId) {
          const pages = await getCollectionThemePages(env, params.collectionId, tg);
          results.push(...pages);
        }
        // ── Mode B: Topic-based search (collection → page_config_ref) ────────
        else if (params.query?.trim()) {
          const collections = await searchCollectionsByKeyword(env, params.query, 10);
          for (const coll of collections) {
            const cId = coll.ref?.id;
            if (!cId) continue;
            const pageConfigRef = coll.properties?.['ccm:page_config_ref']?.[0];
            if (!pageConfigRef) continue;
            const pages = await getCollectionThemePages(env, cId, tg);
            results.push(...pages);
            if (results.length >= (params.maxResults ?? 5)) break;
          }
        }
        // ── Mode C: List all Themenseiten (page_variant API) ─────────────────
        else {
          const eduCtxUri = params.educationalContext
            ? resolveVocab(params.educationalContext, 'educationalContext') ?? params.educationalContext
            : undefined;
          const variants = await searchPageVariants(env, {
            isTemplate: false,
            targetGroup: tg,
            educationalContext: eduCtxUri,
          }, params.maxResults ?? 5);

          for (const v of variants) {
            const vProps = v.properties ?? {};
            results.push({
              variantId: v.ref?.id ?? '',
              variantName: vProps['cm:name']?.[0] || v.name || '',
              targetGroup: vProps['ccm:page_variant_profiling_target_group']?.[0] || 'nicht gesetzt',
              educationalContexts: vProps['ccm:educationalcontext'] ?? [],
              isTemplate: false,
              topicPageUrl: '',
              collectionId: undefined,
              collectionName: undefined,
            });
          }
        }

        if (results.length === 0) {
          const hint = params.query
            ? `Keine Themenseiten für "${params.query}" gefunden. Die Sammlung hat möglicherweise keine konfigurierte Themenseite (ccm:page_config_ref fehlt).`
            : 'Keine Themenseiten gefunden.';
          return { content: [{ type: 'text', text: hint }] };
        }

        // Format output
        const lines: string[] = [`Gefundene Themenseiten: ${results.length}\n`];
        for (const r of results.slice(0, params.maxResults ?? 5)) {
          const parts: string[] = [];
          parts.push(`## ${r.collectionName || r.variantName}`);
          if (r.collectionId) parts.push(`Sammlung-nodeId: ${r.collectionId}`);
          parts.push(`Variante-ID: ${r.variantId}`);
          parts.push(`Zielgruppe: ${r.targetGroup}`);
          if (r.educationalContexts.length) {
            const labels = r.educationalContexts.map(u => {
              const l = labelFromUri(u, 'educationalContext');
              return l !== u ? l : u;
            });
            parts.push(`Bildungsstufe: ${labels.join(', ')}`);
          }
          if (r.topicPageUrl) parts.push(`Themenseite: ${r.topicPageUrl}`);
          lines.push(parts.join('\n'));
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n').trim() }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Fehler bei der Themenseiten-Suche: ${msg}` }], isError: true };
      }
    },
  );

  return server;
}
