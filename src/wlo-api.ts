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
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    contentType,
    maxItems: String(maxItems),
    skipCount: String(skipCount),
    propertyFilter: '-all-',
  });

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
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    filter: 'collections',
    maxItems: String(maxItems),
    skipCount: String(skipCount),
    propertyFilter: '-all-',
  });

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
): Promise<WloNode[]> {
  const params = new URLSearchParams({
    contentType: 'COLLECTIONS',
    maxItems: String(maxItems),
    skipCount: '0',
    propertyFilter: '-all-',
  });
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
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    maxItems: String(maxItems),
    skipCount: String(skipCount),
    propertyFilter: '-all-',
  });
  if (filter !== 'both') params.set('filter', filter);

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
): Promise<WloNode[]> {
  const params = new URLSearchParams({
    filter: 'folders',
    maxItems: String(maxItems),
    skipCount: String(skipCount),
    propertyFilter: '-all-',
  });

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
    propertyFilter: '-all-',
  });
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
): Promise<{ id: string; name: string } | null> {
  // 1) variant → its parent (page_config_node)
  const parentRes = await fetch(
    `${BASE_URL}/node/v1/nodes/-home-/${variantId}/parents?propertyFilter=-all-`,
    { headers: { Accept: 'application/json' } },
  );
  if (!parentRes.ok) return null;
  const parentData = await parentRes.json() as { nodes?: WloNode[]; parents?: WloNode[] };
  const parents = parentData.nodes ?? parentData.parents ?? [];
  if (parents.length === 0) return null;

  // 2) Walk up to find a node whose nodeId matches a collection's
  //    `ccm:page_config_ref` value. We do this by going up one more level:
  //    the page_config_node's parent is itself a config-folder; the
  //    config-folder's id is what `ccm:page_config_ref` points to.
  // Cheaper: take the page_config_node's parent's parent — it's the
  // collection.
  for (const p of parents) {
    const pid = p.ref?.id;
    if (!pid) continue;
    // Walk one more level up
    const grandRes = await fetch(
      `${BASE_URL}/node/v1/nodes/-home-/${pid}/parents?propertyFilter=-all-`,
      { headers: { Accept: 'application/json' } },
    );
    if (!grandRes.ok) continue;
    const grandData = await grandRes.json() as { nodes?: WloNode[]; parents?: WloNode[] };
    const grand = (grandData.nodes ?? grandData.parents ?? []);
    for (const g of grand) {
      const gprops = g.properties ?? {};
      // The collection node has page_config_ref AND is_template/folder-y
      if (gprops['ccm:page_config_ref']?.length) {
        const name = gprops['cclom:title']?.[0] ?? gprops['cm:name']?.[0] ?? g.name ?? '';
        const id = g.ref?.id ?? '';
        if (id) return { id, name };
      }
    }
  }
  return null;
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
  const configChildren = await getChildCollections(configId, 50);
  const results: ThemePageInfo[] = [];
  const collectionName = props['cclom:title']?.[0] || props['cm:name']?.[0] || node.name || '';
  const topicPageUrl = buildTopicPageUrl(collectionId, pageConfigRef) ?? '';

  for (const configNode of configChildren) {
    const configNodeId = configNode.ref?.id;
    if (!configNodeId) continue;

    // Get variants (files) under each page_config
    const variantResp = await getCollectionContents(configNodeId, 'both', 50);
    for (const variant of variantResp.nodes) {
      const vProps = variant.properties ?? {};
      const isTemplate = vProps['ccm:page_variant_is_template']?.[0] === 'true';
      if (isTemplate) continue;

      const vTargetGroup = vProps['ccm:page_variant_profiling_target_group']?.[0] || '';
      if (targetGroup && vTargetGroup && vTargetGroup !== targetGroup) continue;

      const eduContexts = vProps['ccm:educationalcontext'] ?? [];

      results.push({
        variantId: variant.ref?.id ?? '',
        variantName: vProps['cm:name']?.[0] || variant.name || '',
        variantTitle: vProps['cclom:title']?.[0] || vProps['cm:title']?.[0] || '',
        targetGroup: vTargetGroup || 'nicht gesetzt',
        educationalContexts: eduContexts,
        isTemplate: false,
        topicPageUrl,
        collectionId,
        collectionName,
      });
    }
  }
  return results;
}

