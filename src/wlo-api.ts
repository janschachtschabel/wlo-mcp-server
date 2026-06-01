/**
 * wlo-api.ts – Minimal WLO / EduSharing API client
 * Targets the public REST API of WirLernenOnline.
 *
 * The server points at a single edu-sharing instance per process. Pick it
 * via the ``WLO_REPOSITORY_URL`` env variable (e.g.
 * ``https://redaktion.openeduhub.net/edu-sharing`` or
 * ``https://repository.staging.openeduhub.net/edu-sharing``). The endpoint
 * paths below (``/rest/search/v1/...``, ``/rest/node/v1/...``,
 * ``/components/render/<id>``, ``/components/topic-pages?...``) are
 * identical across instances, so the only difference between prod and
 * staging is the base URL — which is exactly what this var encodes.
 */

/**
 * Sanitize a repository URL input. Forgives common user-typo cases:
 *
 *   - leading/trailing whitespace
 *   - one or more trailing slashes
 *   - a trailing ``/rest`` segment that users sometimes paste from the
 *     REST docs (the MCP server appends ``/rest`` itself, so a double
 *     ``/rest/rest`` would 404)
 *   - missing protocol → defaults to ``https://``
 *
 * Returns the empty string for empty/whitespace-only input so the
 * caller can decide whether to apply a default.
 */
export function sanitizeRepositoryUrl(raw: string): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  // Strip one or more trailing slashes.
  s = s.replace(/\/+$/, '');
  // Common paste mistake: trailing /rest segment (which we add ourselves).
  // ``\/rest$`` after slash-stripping covers both ``…/rest`` and ``…/rest/``.
  s = s.replace(/\/rest$/i, '');
  // Bare hostname → prepend https:// so the URL is parseable by fetch().
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  // Auto-append /edu-sharing when only the bare host was given
  // (e.g. "https://repository.staging.openeduhub.net").
  if (!/\/edu-sharing(\/|$)/i.test(s)) s += '/edu-sharing';
  return s;
}

/**
 * Frontend base URL (e.g. ``https://redaktion.openeduhub.net/edu-sharing``).
 * Resolved once from ``WLO_REPOSITORY_URL`` at module load; defaults to
 * the WLO production redaction instance so unconfigured deploys still
 * work as before. Logs a warning when the configured value looks
 * suspicious (e.g. ends in ``/components`` or contains ``/edu-sharing``
 * twice) — those are typically the result of pasting a deep link
 * instead of the repository root.
 */
const _DEFAULT_REPOSITORY_URL = 'https://redaktion.openeduhub.net/edu-sharing';
export const WLO_REPOSITORY_URL: string = (() => {
  const raw = process.env['WLO_REPOSITORY_URL'] ?? '';
  const cleaned = sanitizeRepositoryUrl(raw);
  const resolved = cleaned || _DEFAULT_REPOSITORY_URL;

  // Soft validation — warn but don't crash. We log to stderr so stdio
  // transport users still see the warning even if stdout is reserved
  // for MCP framing.
  const suspicious: string[] = [];
  if (/\/components($|\/)/i.test(resolved)) {
    suspicious.push('URL ends in "/components" — looks like a deep page link, not the repository root');
  }
  // Lookahead (?=...) instead of capture-group so adjacent matches
  // ("/edu-sharing/edu-sharing") are counted separately.
  if ((resolved.match(/\/edu-sharing(?=\/|$)/gi)?.length ?? 0) > 1) {
    suspicious.push('URL contains "/edu-sharing" more than once');
  }
  if (suspicious.length > 0) {
    console.warn(
      `[wlo-mcp] WLO_REPOSITORY_URL looks suspicious: ${suspicious.join('; ')}. ` +
      `Resolved value: "${resolved}". ` +
      `Expected format: "https://<host>/edu-sharing" (no trailing /rest, no /components).`,
    );
  }
  return resolved;
})();

/** REST API base — ``<repository-url>/rest``. */
export const BASE_URL: string = `${WLO_REPOSITORY_URL}/rest`;

/**
 * Central/root collection nodeId of the configured repository.
 *
 * Default is the WLO root (``5e40e372-...``) which is the same node ID
 * on the staging mirror today. Override per deployment via
 * ``WLO_ROOT_COLLECTION_ID`` if a future staging/development repo uses
 * a different root.
 */
export const WLO_ROOT_COLLECTION_ID: string = (() => {
  const raw = (process.env['WLO_ROOT_COLLECTION_ID'] ?? '').trim();
  return raw || '5e40e372-735c-4b17-bbf7-e827a5702b57';
})();

export interface SearchCriterion {
  property: string;
  values: string[];
}

export interface WloNode {
  ref?: { id: string; repo: string };
  name?: string;
  title?: string;
  isDirectory?: boolean;
  /** edu-sharing object type — `ccm:io` (file) or `ccm:map` (collection). */
  type?: string;
  /** MIME type, e.g. `application/pdf` (only on `ccm:io` nodes). */
  mimetype?: string;
  /** Coarse mediatype label, e.g. `file-pdf`, `file-video`. */
  mediatype?: string;
  /** File size in bytes (only on file nodes with binary content). */
  size?: number;
  /** Direct binary download URL — works without auth; null if no binary content. */
  downloadUrl?: string | null;
  properties?: Record<string, string[]>;
  preview?: {
    url?: string;
    /** `true` = generic mediatype icon, `false` = real generated thumbnail */
    isIcon?: boolean;
    isGenerated?: boolean;
  };
  /**
   * In-repo viewer URL (PDF/video preview component). Null when the node
   * has no binary attachment (e.g. external link nodes via `ccm:wwwurl`).
   */
  content?: { url?: string; originalUrl?: string; hash?: string; version?: string };
  collection?: { description?: string; title?: string; childCollectionsCount?: number };
}

export interface SearchResponse {
  nodes: WloNode[];
  pagination: { total: number; from: number; count: number };
}

const HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

// ── Property-Filter (O2: nur real genutzte Felder anfordern) ──────────────────
//
// edu-sharing akzeptiert ``propertyFilter`` NUR als WIEDERHOLTEN Query-Param
// (``&propertyFilter=a&propertyFilter=b``). Eine Kommaliste liefert 0 Properties
// (verifiziert gegen Staging 2026-06). ``_DISPLAYNAME``-Begleitfelder MÜSSEN
// explizit mitgelistet werden — kommen dann aber korrekt zurück.
//
// DISPLAY_PROPS = das von formatter.ts + reranker.ts real konsumierte Set
// (statt ``-all-`` mit ~59 Properties/Node → ~24 → deutlich kleinere Payloads
// bei 6 Query-Varianten × bis zu 40 Treffern).
export const DISPLAY_PROPS: string[] = [
  // Titel + Beschreibung + Ranking
  'cclom:title', 'cm:title', 'cm:name',
  'cclom:general_description', 'cclom:general_keyword',
  // Vokabular-Felder (+ server-seitige Labels)
  'ccm:taxonid', 'ccm:taxonid_DISPLAYNAME',
  'ccm:educationalcontext', 'ccm:educationalcontext_DISPLAYNAME',
  'ccm:educationalintendedenduserrole', 'ccm:educationalintendedenduserrole_DISPLAYNAME',
  'ccm:oeh_lrt_aggregated', 'ccm:oeh_lrt_aggregated_DISPLAYNAME',
  'ccm:oeh_lrt', 'ccm:oeh_lrt_DISPLAYNAME',
  // Links / Lizenz / Quelle
  'ccm:wwwurl', 'ccm:commonlicense_key',
  'ccm:oeh_publisher_combined',
  'ccm:replicationsource', 'ccm:replicationsource_DISPLAYNAME', // Bezugsquelle (z.B. Klexikon)
  'ccm:author_freetext',
  // Struktur / IDs
  'ccm:page_config_ref',
  'sys:node-uuid', 'virtual:primaryparent_nodeid',
];

// Themenseiten-Varianten brauchen zusätzlich die page_variant-Felder
// (Template-Flag, Zielgruppe, Swimlane-Config).
export const TOPIC_PAGE_PROPS: string[] = [
  ...DISPLAY_PROPS,
  'ccm:page_variant_is_template',
  'ccm:page_variant_profiling_target_group',
  'ccm:page_variant_config',
];

/**
 * Hängt den ``propertyFilter`` an die Query-Params an. ``props`` undefined ODER
 * leer ⇒ ``-all-`` (Voll-Set, z.B. für get_node_details). Sonst pro Feld EIN
 * wiederholter ``propertyFilter``-Param (das ist das einzige Format, das
 * edu-sharing für Feldauswahl akzeptiert).
 */
function appendPropertyFilter(params: URLSearchParams, props?: string[]): void {
  if (props && props.length > 0) {
    for (const p of props) params.append('propertyFilter', p);
  } else {
    params.append('propertyFilter', '-all-');
  }
}

/**
 * Build the topic-pages URL for a collection that has ccm:page_config_ref.
 * Returns null if pageConfigRef is falsy.
 */
export function buildTopicPageUrl(
  collectionId: string,
  pageConfigRef?: string | null,
): string | null {
  if (!pageConfigRef) return null;
  return `${WLO_REPOSITORY_URL}/components/topic-pages?collectionId=${collectionId}`;
}

/**
 * Build the in-repo viewer URL (``/components/render/<id>``) for a node.
 * Used by ``get_node_details`` to expose a stable permalink.
 */
export function buildRenderUrl(nodeId: string): string {
  return `${WLO_REPOSITORY_URL}/components/render/${nodeId}`;
}

/**
 * POST /search/v1/queries/-home-/mds_oeh/ngsearch
 * Search for FILE nodes. Uses contentType=FILES (default).
 * NOTE: contentType=FOLDERS/COLLECTIONS returns 0 for anonymous users —
 *       use ngsearchCollections() with filter=collections instead.
 */
export type NgsearchContentType = 'FILES' | 'FILES_AND_FOLDERS';

export async function ngsearch(
  criteria: SearchCriterion[],
  contentType: NgsearchContentType = 'FILES',
  maxItems = 20,
  skipCount = 0,
  props: string[] | undefined = DISPLAY_PROPS,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    contentType,
    maxItems: String(maxItems),
    skipCount: String(skipCount),
  });
  appendPropertyFilter(params, props);

  const url = `${BASE_URL}/search/v1/queries/-home-/mds_oeh/ngsearch?${params}`;
  const body = JSON.stringify({ criteria: criteria.map(c => ({ property: c.property, values: c.values })) });

  const res = await fetch(url, { method: 'POST', headers: HEADERS, body });
  if (!res.ok) throw new Error(`ngsearch failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as { nodes?: WloNode[]; pagination?: SearchResponse['pagination'] };
  return {
    nodes: data.nodes ?? [],
    pagination: data.pagination ?? { total: 0, from: 0, count: 0 },
  };
}

/**
 * POST /search/v1/queries/-home-/mds_oeh/ngsearch?filter=collections
 * Search for COLLECTION nodes using the filter= query parameter.
 * This is the correct way to search collections — contentType=FOLDERS/COLLECTIONS
 * returns 0 for anonymous access, but filter=collections works.
 */
export async function ngsearchCollections(
  criteria: SearchCriterion[],
  maxItems = 20,
  skipCount = 0,
  props: string[] | undefined = DISPLAY_PROPS,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    filter: 'collections',
    maxItems: String(maxItems),
    skipCount: String(skipCount),
  });
  appendPropertyFilter(params, props);

  const url = `${BASE_URL}/search/v1/queries/-home-/mds_oeh/ngsearch?${params}`;
  const body = JSON.stringify({ criteria: criteria.map(c => ({ property: c.property, values: c.values })) });

  const res = await fetch(url, { method: 'POST', headers: HEADERS, body });
  if (!res.ok) throw new Error(`ngsearchCollections failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as { nodes?: WloNode[]; pagination?: SearchResponse['pagination'] };
  return {
    nodes: data.nodes ?? [],
    pagination: data.pagination ?? { total: 0, from: 0, count: 0 },
  };
}

/**
 * POST /search/v1/queries/-home-/mds_oeh/collections?contentType=COLLECTIONS
 * Full-text keyword search that returns real COLLECTION nodes (isDirectory=true).
 * Unlike ngsearch with filter=collections, this endpoint correctly returns ccm:map nodes.
 */
export async function searchCollectionsByKeyword(
  query: string,
  maxItems = 10,
  props: string[] | undefined = DISPLAY_PROPS,
): Promise<WloNode[]> {
  const params = new URLSearchParams({
    contentType: 'COLLECTIONS',
    maxItems: String(maxItems),
    skipCount: '0',
  });
  appendPropertyFilter(params, props);
  const url = `${BASE_URL}/search/v1/queries/-home-/mds_oeh/collections?${params}`;
  const body = JSON.stringify({ criteria: [{ property: 'ngsearchword', values: [query] }] });
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body });
  if (!res.ok) return [];
  const data = await res.json() as { nodes?: WloNode[] };
  return data.nodes ?? [];
}

/**
 * GET /node/v1/nodes/-home-/{nodeId}/children
 * filter: 'files' → Inhalte, 'folders' → Sub-Sammlungen, undefined → beides
 */
export async function getCollectionContents(
  nodeId: string,
  filter: 'files' | 'folders' | 'both' = 'files',
  maxItems = 30,
  skipCount = 0,
  props: string[] | undefined = DISPLAY_PROPS,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    maxItems: String(maxItems),
    skipCount: String(skipCount),
  });
  if (filter !== 'both') params.set('filter', filter);
  appendPropertyFilter(params, props);

  const url = `${BASE_URL}/node/v1/nodes/-home-/${nodeId}/children?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`getCollectionContents failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as { nodes?: WloNode[]; pagination?: SearchResponse['pagination'] };
  return {
    nodes: data.nodes ?? [],
    pagination: data.pagination ?? { total: 0, from: 0, count: 0 },
  };
}

/**
 * GET /node/v1/nodes/-home-/{nodeId}/children?filter=folders
 * Returns direct sub-collections of a collection node.
 * Same endpoint as getCollectionContents but with filter=folders.
 */
export async function getChildCollections(
  nodeId: string,
  maxItems = 100,
  skipCount = 0,
  props: string[] | undefined = DISPLAY_PROPS,
): Promise<WloNode[]> {
  const params = new URLSearchParams({
    filter: 'folders',
    maxItems: String(maxItems),
    skipCount: String(skipCount),
  });
  appendPropertyFilter(params, props);

  const url = `${BASE_URL}/node/v1/nodes/-home-/${nodeId}/children?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];

  const data = await res.json() as { nodes?: WloNode[] };
  return data.nodes ?? [];
}

/**
 * GET /node/v1/nodes/-home-/{nodeId}/metadata?propertyFilter=-all-
 * Fetch metadata for a single node (FILE or COLLECTION).
 */
export async function getNodeMetadata(
  nodeId: string,
): Promise<WloNode | null> {
  const url = `${BASE_URL}/node/v1/nodes/-home-/${nodeId}/metadata?propertyFilter=-all-`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json() as { node?: WloNode };
  return data.node ?? null;
}

/**
 * Fetch metadata for multiple node IDs in parallel.
 * Uses GET /node/v1/nodes/-home-/{id}/metadata per node.
 */
export async function getCollectionMetadata(
  nodeIds: string[],
): Promise<WloNode[]> {
  if (nodeIds.length === 0) return [];
  const settled = await Promise.allSettled(
    nodeIds.map(id => getNodeMetadata(id))
  );
  return settled
    .filter((r): r is PromiseFulfilledResult<WloNode> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}

/**
 * GET /node/v1/nodes/-home-/{nodeId}/textContent
 * Returns the stored full-text content of a node (web page text, PDF extract, etc.).
 */
export async function getNodeTextContent(
  nodeId: string,
): Promise<string | null> {
  const url = `${BASE_URL}/node/v1/nodes/-home-/${nodeId}/textContent`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json() as { content?: string; text?: string };
  return data.content ?? data.text ?? null;
}

/**
 * GET /node/v1/nodes/-home-/{nodeId}/parents?propertyFilter=-all-
 * Returns the parent nodes (collections) of a given node.
 */
export async function getNodeParents(
  nodeId: string,
): Promise<WloNode[]> {
  const url = `${BASE_URL}/node/v1/nodes/-home-/${nodeId}/parents?propertyFilter=-all-`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const data = await res.json() as { nodes?: WloNode[]; parents?: WloNode[] };
  return data.nodes ?? data.parents ?? [];
}

// ── Theme pages (page_variant) ────────────────────────────────────────────────

export type TargetGroup = 'teacher' | 'learner' | 'general';

export interface ThemePageInfo {
  variantId: string;
  variantName: string;
  /**
   * Human-readable title of the page-variant node itself (`cm:title`,
   * e.g. "Seiten-Variante 1"). Distinct from `variantName`, which holds
   * the auto-generated technical `cm:name` ("PAGE_VARIANT_<uuid>").
   * Used as a display fallback when the owning collection can't be
   * resolved, so the UI never shows the raw PAGE_VARIANT/UUID string.
   */
  variantTitle?: string;
  targetGroup: string;
  educationalContexts: string[];
  isTemplate: boolean;
  topicPageUrl: string;
  collectionId?: string;
  collectionName?: string;
}

/**
 * POST /search/v1/queries/-home-/mds_oeh/page_variant
 * Search for page_variant nodes (Themenseiten-Varianten).
 * Supports filtering by is_template, target_group, and educationalcontext.
 * Does NOT support full-text search (ngsearchword returns 0).
 */
export async function searchPageVariants(
  options: {
    isTemplate?: boolean;
    targetGroup?: TargetGroup;
    educationalContext?: string;
  } = {},
  maxItems = 50,
): Promise<WloNode[]> {
  const criteria: SearchCriterion[] = [];
  criteria.push({
    property: 'ccm:page_variant_is_template',
    values: [String(options.isTemplate ?? false)],
  });
  if (options.targetGroup) {
    criteria.push({
      property: 'ccm:page_variant_profiling_target_group',
      values: [options.targetGroup],
    });
  }
  if (options.educationalContext) {
    criteria.push({
      property: 'ccm:educationalcontext',
      values: [options.educationalContext],
    });
  }

  const params = new URLSearchParams({
    contentType: 'ALL',
    maxItems: String(maxItems),
    skipCount: '0',
  });
  appendPropertyFilter(params, TOPIC_PAGE_PROPS);
  const url = `${BASE_URL}/search/v1/queries/-home-/mds_oeh/page_variant?${params}`;
  const body = JSON.stringify({ criteria });
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body });
  if (!res.ok) return [];
  const data = await res.json() as { nodes?: WloNode[] };
  return data.nodes ?? [];
}

/**
 * Resolve a page-variant node back to its owning collection by walking
 * parent → page_config → collection. Returns { id, name } or null.
 *
 * This is needed for Mode C of search_wlo_topic_pages where we list all
 * variants but don't yet know which collection each belongs to.
 */
export async function resolveVariantCollection(
  variantId: string,
  parentCache?: Map<string, { id: string; name: string } | null>,
  knownParentId?: string,
): Promise<{ id: string; name: string } | null> {
  // Resolve ONE page_config parent → its owning collection (the node that
  // carries `ccm:page_config_ref`). Memoized by parent-id: sibling variants
  // of the same Themenseite share the same parent, so the (expensive) walk
  // runs only once per parent across a whole Mode-C batch.
  const resolveParent = async (pid: string): Promise<{ id: string; name: string } | null> => {
    if (parentCache?.has(pid)) return parentCache.get(pid)!;
    let result: { id: string; name: string } | null = null;
    const grandRes = await fetch(
      `${BASE_URL}/node/v1/nodes/-home-/${pid}/parents?propertyFilter=-all-`,
      { headers: { Accept: 'application/json' } },
    );
    if (grandRes.ok) {
      const grandData = await grandRes.json() as { nodes?: WloNode[]; parents?: WloNode[] };
      for (const g of (grandData.nodes ?? grandData.parents ?? [])) {
        const gprops = g.properties ?? {};
        if (gprops['ccm:page_config_ref']?.length) {
          const id = g.ref?.id ?? '';
          if (id) {
            result = { id, name: gprops['cclom:title']?.[0] ?? gprops['cm:name']?.[0] ?? g.name ?? '' };
            break;
          }
        }
      }
    }
    parentCache?.set(pid, result);
    return result;
  };

  // Determine which parent(s) to resolve. A page variant lives under exactly
  // one page_config folder, so its known primary parent
  // (virtual:primaryparent_nodeid, present on every page_variant search hit)
  // is authoritative — use it directly and skip the variant→parents round-
  // trip entirely. We only fetch the parents list when no parent is known.
  let pids: string[];
  if (knownParentId) {
    pids = [knownParentId];
  } else {
    const parentRes = await fetch(
      `${BASE_URL}/node/v1/nodes/-home-/${variantId}/parents?propertyFilter=-all-`,
      { headers: { Accept: 'application/json' } },
    );
    if (!parentRes.ok) return null;
    const parentData = await parentRes.json() as { nodes?: WloNode[]; parents?: WloNode[] };
    pids = (parentData.nodes ?? parentData.parents ?? [])
      .map(p => p.ref?.id)
      .filter((x): x is string => !!x);
  }
  if (pids.length === 0) return null;
  // Parents resolved in parallel (usually one), each memoized by parent-id.
  const resolved = await Promise.all(pids.map(resolveParent));
  return resolved.find(r => r !== null) ?? null;
}

/**
 * Given a collection nodeId, check if it has ccm:page_config_ref and resolve
 * the theme page variants underneath it.
 * Returns an array of ThemePageInfo with variant details.
 */
export async function getCollectionThemePages(
  collectionId: string,
  targetGroup?: TargetGroup,
): Promise<ThemePageInfo[]> {
  const node = await getNodeMetadata(collectionId);
  if (!node) return [];

  const props = node.properties ?? {};
  const pageConfigRef = props['ccm:page_config_ref']?.[0];
  if (!pageConfigRef) return [];

  // Extract nodeId from "workspace://SpacesStore/{id}"
  const configId = pageConfigRef.replace('workspace://SpacesStore/', '');

  // Config folder → children (page_config nodes) → their children (PAGE_VARIANT)
  const configChildren = await getChildCollections(configId, 50, 0, TOPIC_PAGE_PROPS);
  const collectionName = props['cclom:title']?.[0] || props['cm:name']?.[0] || node.name || '';
  const topicPageUrl = buildTopicPageUrl(collectionId, pageConfigRef) ?? '';

  // O5: Varianten ALLER page_config-Kinder PARALLEL holen (vorher eine
  // sequenzielle ``for … await``-Schleife — bei N Kindern = N serielle Calls).
  const perConfig = await Promise.all(
    configChildren.map(async (configNode): Promise<ThemePageInfo[]> => {
      const configNodeId = configNode.ref?.id;
      if (!configNodeId) return [];
      const variantResp = await getCollectionContents(configNodeId, 'both', 50, 0, TOPIC_PAGE_PROPS);
      const out: ThemePageInfo[] = [];
      for (const variant of variantResp.nodes) {
        const vProps = variant.properties ?? {};
        const isTemplate = vProps['ccm:page_variant_is_template']?.[0] === 'true';
        if (isTemplate) continue;

        const vTargetGroup = vProps['ccm:page_variant_profiling_target_group']?.[0] || '';
        if (targetGroup && vTargetGroup && vTargetGroup !== targetGroup) continue;

        out.push({
          variantId: variant.ref?.id ?? '',
          variantName: vProps['cm:name']?.[0] || variant.name || '',
          variantTitle: vProps['cclom:title']?.[0] || vProps['cm:title']?.[0] || '',
          targetGroup: vTargetGroup || 'nicht gesetzt',
          educationalContexts: vProps['ccm:educationalcontext'] ?? [],
          isTemplate: false,
          topicPageUrl,
          collectionId,
          collectionName,
        });
      }
      return out;
    }),
  );
  return perConfig.flat();
}

// ── Theme page CONTENT (swimlane structure) ───────────────────────────────────

/** One item inside a swimlane: a widget plus the optional embedded node it shows. */
export interface SwimlaneItem {
  /** Widget type, e.g. "content-teaser", "ai-text", "wlo-collection-chips". */
  widget: string;
  /** Embedded content/collection nodeId (bare UUID), if the widget references one. */
  nodeId?: string;
}

/** One section of a Themenseite. */
export interface Swimlane {
  heading: string;
  /** Layout type, e.g. "container" or "accordion". */
  type: string;
  items: SwimlaneItem[];
}

/** Parsed content structure of a single page variant. */
export interface TopicPageStructure {
  collectionId?: string;
  variantId: string;
  variantTitle: string;
  swimlanes: Swimlane[];
  /** Flat, de-duplicated list of every embedded nodeId across all swimlanes. */
  referencedNodeIds: string[];
}

function stripStoreRef(s: string | undefined): string {
  return (s ?? '').replace('workspace://SpacesStore/', '');
}

/** Parse a ``ccm:page_variant_config`` JSON string into ordered swimlanes. */
function parsePageVariantConfig(raw: string | undefined): Swimlane[] {
  if (!raw) return [];
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const swimlanes = parsed?.structure?.swimlanes;
  if (!Array.isArray(swimlanes)) return [];
  return swimlanes.map((sl: any): Swimlane => {
    const grid = Array.isArray(sl?.grid) ? sl.grid : [];
    const items: SwimlaneItem[] = grid
      .map((g: any): SwimlaneItem => ({
        widget: typeof g?.item === 'string' ? g.item : '',
        nodeId: g?.nodeId ? stripStoreRef(String(g.nodeId)) : undefined,
      }))
      .filter((it: SwimlaneItem) => it.widget || it.nodeId);
    return {
      heading: typeof sl?.heading === 'string' ? sl.heading : '',
      type: typeof sl?.type === 'string' ? sl.type : '',
      items,
    };
  });
}

/**
 * Resolve the CONTENT STRUCTURE of a Themenseite — its swimlane sections plus
 * the node IDs embedded in each. Pass a ``variantId`` directly (fast: one
 * fetch) or a ``collectionId`` (resolves the owning collection's page config
 * to a variant). ``targetGroup`` picks a specific variant when resolving by
 * collection. Returns null when nothing resolvable.
 */
export async function getTopicPageContent(
  opts: { collectionId?: string; variantId?: string; targetGroup?: TargetGroup },
): Promise<TopicPageStructure | null> {
  const seedId = opts.variantId || opts.collectionId;
  if (!seedId) return null;

  // Fetch the seed node. It may already be the page variant itself (carries
  // ccm:page_variant_config) or the owning collection (carries
  // ccm:page_config_ref pointing at the config folder). Handling both makes
  // the tool robust regardless of which id the caller passes.
  let variantNode: WloNode | null = await getNodeMetadata(seedId);
  const hasVariantConfig = (n: WloNode | null) => !!n?.properties?.['ccm:page_variant_config']?.[0];

  if (variantNode && !hasVariantConfig(variantNode)) {
    const ref = variantNode.properties?.['ccm:page_config_ref']?.[0];
    if (!ref) return null;
    const configChildren = await getChildCollections(stripStoreRef(ref), 50, 0, TOPIC_PAGE_PROPS);
    // O5: alle page_config-Kinder PARALLEL laden, dann den ersten passenden
    // Treffer in ursprünglicher Reihenfolge wählen (vorher sequenziell).
    const contentsPerChild = await Promise.all(
      configChildren.map(cn => {
        const cnId = cn.ref?.id;
        return cnId
          ? getCollectionContents(cnId, 'both', 50, 0, TOPIC_PAGE_PROPS)
          : Promise.resolve(null);
      }),
    );
    let picked: WloNode | null = null;
    for (const vr of contentsPerChild) {
      if (!vr) continue;
      const candidates = vr.nodes.filter(
        n => n.properties?.['ccm:page_variant_is_template']?.[0] !== 'true',
      );
      const pick = opts.targetGroup
        ? candidates.find(
            n => n.properties?.['ccm:page_variant_profiling_target_group']?.[0] === opts.targetGroup,
          )
        : candidates[0];
      if (pick) { picked = pick; break; }
    }
    variantNode = picked;
  }

  if (!variantNode) return null;

  const vProps = variantNode.properties ?? {};
  const swimlanes = parsePageVariantConfig(vProps['ccm:page_variant_config']?.[0]);
  const referencedNodeIds = [
    ...new Set(
      swimlanes.flatMap(s => s.items.map(i => i.nodeId).filter((x): x is string => !!x)),
    ),
  ];
  return {
    collectionId: opts.collectionId,
    variantId: variantNode.ref?.id ?? opts.variantId ?? '',
    variantTitle: vProps['cclom:title']?.[0] || vProps['cm:title']?.[0] || '',
    swimlanes,
    referencedNodeIds,
  };
}

