/**
 * wlo-api.ts – Minimal WLO / EduSharing API client
 * Targets the public REST API of WirLernenOnline.
 */

export type WloEnvironment = 'production' | 'staging';

/** Central/root collection nodeId of the WLO repository. */
export const WLO_ROOT_COLLECTION_IDS: Record<WloEnvironment, string> = {
  production: '5e40e372-735c-4b17-bbf7-e827a5702b57',
  staging:    '5e40e372-735c-4b17-bbf7-e827a5702b57',
};

const BASE_URLS: Record<WloEnvironment, string> = {
  production: 'https://redaktion.openeduhub.net/edu-sharing/rest',
  staging:    'https://repository.staging.openeduhub.net/edu-sharing/rest',
};

export interface SearchCriterion {
  property: string;
  values: string[];
}

export interface WloNode {
  ref?: { id: string; repo: string };
  name?: string;
  title?: string;
  isDirectory?: boolean;
  properties?: Record<string, string[]>;
  preview?: { url?: string; isIcon?: boolean };
  content?: { url?: string };
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

function base(env: WloEnvironment): string {
  return BASE_URLS[env];
}

/**
 * POST /search/v1/queries/-home-/mds_oeh/ngsearch
 * Search for FILE nodes. Uses contentType=FILES (default).
 * NOTE: contentType=FOLDERS/COLLECTIONS returns 0 for anonymous users —
 *       use ngsearchCollections() with filter=collections instead.
 */
export type NgsearchContentType = 'FILES' | 'FILES_AND_FOLDERS';

export async function ngsearch(
  env: WloEnvironment,
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

  const url = `${base(env)}/search/v1/queries/-home-/mds_oeh/ngsearch?${params}`;
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
  env: WloEnvironment,
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

  const url = `${base(env)}/search/v1/queries/-home-/mds_oeh/ngsearch?${params}`;
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
  env: WloEnvironment,
  query: string,
  maxItems = 10,
): Promise<WloNode[]> {
  const params = new URLSearchParams({
    contentType: 'COLLECTIONS',
    maxItems: String(maxItems),
    skipCount: '0',
  });
  const url = `${base(env)}/search/v1/queries/-home-/mds_oeh/collections?${params}`;
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
  env: WloEnvironment,
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

  const url = `${base(env)}/node/v1/nodes/-home-/${nodeId}/children?${params}`;
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
  env: WloEnvironment,
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

  const url = `${base(env)}/node/v1/nodes/-home-/${nodeId}/children?${params}`;
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
  env: WloEnvironment,
  nodeId: string,
): Promise<WloNode | null> {
  const url = `${base(env)}/node/v1/nodes/-home-/${nodeId}/metadata?propertyFilter=-all-`;
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
  env: WloEnvironment,
  nodeIds: string[],
): Promise<WloNode[]> {
  if (nodeIds.length === 0) return [];
  const settled = await Promise.allSettled(
    nodeIds.map(id => getNodeMetadata(env, id))
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
  env: WloEnvironment,
  nodeId: string,
): Promise<string | null> {
  const url = `${base(env)}/node/v1/nodes/-home-/${nodeId}/textContent`;
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
  env: WloEnvironment,
  nodeId: string,
): Promise<WloNode[]> {
  const url = `${base(env)}/node/v1/nodes/-home-/${nodeId}/parents?propertyFilter=-all-`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const data = await res.json() as { nodes?: WloNode[]; parents?: WloNode[] };
  return data.nodes ?? data.parents ?? [];
}

// ── Web content extraction ────────────────────────────────────────────────────

const TEXT_EXTRACTION_URL = 'https://text-extraction.staging.openeduhub.net/from-url';

/** Whitelisted origins whose pages may be fetched. Subpages are always allowed. */
export const WEB_CONTENT_WHITELIST: string[] = [
  'https://www.wirlernenonline.de',
  'https://edu-sharing-network.org',
  'https://edu-sharing.com',
  'https://metaventis.com',
];

/**
 * Check whether a URL belongs to one of the whitelisted origins.
 * Subpaths and trailing-slash variants are accepted.
 */
export function isAllowedUrl(url: string): boolean {
  try {
    const target = new URL(url);
    return WEB_CONTENT_WHITELIST.some(allowed => {
      const origin = new URL(allowed);
      return (
        target.hostname === origin.hostname ||
        target.hostname.endsWith('.' + origin.hostname)
      );
    });
  } catch {
    return false;
  }
}

/**
 * POST https://text-extraction.staging.openeduhub.net/from-url
 * Extracts the text content of a webpage and returns it as Markdown.
 * Only whitelisted URLs are accepted.
 */
export async function fetchWebContent(url: string): Promise<string> {
  if (!isAllowedUrl(url)) {
    throw new Error(
      `URL nicht erlaubt. Nur Seiten der folgenden Domains sind zulässig: ${WEB_CONTENT_WHITELIST.join(', ')}`
    );
  }

  const body = JSON.stringify({
    url,
    method: 'browser',
    browser_location: null,
    lang: 'auto',
    output_format: 'markdown',
    preference: 'none',
  });

  const res = await fetch(TEXT_EXTRACTION_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Text-Extraktion fehlgeschlagen: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as Record<string, unknown>;
  // The service may return the content under different keys
  const content = (data['content'] ?? data['text'] ?? data['markdown'] ?? data['result'] ?? '') as string;
  return content;
}
