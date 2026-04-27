/**
 * formatter.ts – Extract and clean WLO node properties into a structured output.
 */

import type { WloNode, WloEnvironment } from './wlo-api.js';
import { buildTopicPageUrl } from './wlo-api.js';
import { labelFromUri } from './vocabs.js';

export interface FormattedNode {
  nodeId: string;
  title: string;
  description: string;
  keywords: string[];
  disciplines: string[];
  educationalContexts: string[];
  userRoles: string[];
  learningResourceTypes: string[];
  /**
   * Primary "open this resource" link. Priority:
   *   1. `ccm:wwwurl` — external link (most content nodes)
   *   2. `node.content.url` — in-repo viewer (PDF/video preview)
   *   3. empty (the consumer should fall back to render-by-nodeId)
   */
  url: string;
  /**
   * Direct binary download (without auth). Set only on file nodes whose
   * server returned a `downloadUrl`. Null for external-link nodes and
   * collections.
   */
  downloadUrl: string;
  /**
   * In-repo viewer URL (`/components/render/<id>` style). Useful when a
   * frontend wants to embed the edu-sharing PDF/video preview component.
   * Empty for external-link-only nodes.
   */
  contentUrl: string;
  /** Thumbnail URL — may be a generic mediatype icon, see `previewIsIcon`. */
  previewUrl: string;
  /**
   * `true` = thumbnail is a generic icon (no real preview was generated).
   * Frontends can use this to decide between rendering the icon as small/
   * subdued vs. featuring a true thumbnail prominently.
   */
  previewIsIcon: boolean;
  /** MIME type if the node has a binary attachment, e.g. `application/pdf`. */
  mimeType: string;
  /** File size in bytes (0 for nodes without binary content). */
  fileSize: number;
  license: string;
  publisher: string;
  nodeType: 'collection' | 'content';
  topicPageUrl: string;
}

function first(arr: string[] | undefined): string {
  return arr?.[0] ?? '';
}

/**
 * Resolve a vocab-backed property to display labels.
 *
 * **Priority order (deliberate):**
 *
 * 1. **`<property>_DISPLAYNAME`** — server-side resolved labels straight
 *    from the edu-sharing index. This is the *only* source that covers
 *    BOTH the school discipline vocab AND the Hochschulfächersystematik
 *    (and any future vocab) without us maintaining hundreds of mappings
 *    locally. Verified to be present for `ccm:taxonid`,
 *    `ccm:educationalcontext`, `ccm:oeh_lrt_aggregated`.
 *
 * 2. **Local `labelFromUri` lookup** — fallback for legacy data and
 *    properties where `_DISPLAYNAME` isn't populated (e.g.
 *    `ccm:commonlicense_key` — license keys are stored as raw strings
 *    like `CC_BY_SA` and have no server-side display name).
 *
 * 3. **Raw URI** — final fallback inside `labelFromUri` so the consumer
 *    sees something rather than nothing.
 *
 * Why we do NOT use `_DISPLAYNAME` for label-→-URI resolution
 * (`resolveVocab`): user inputs like "Mathematik" are ambiguous between
 * the school vocab (`discipline/380` = Mathematik) and Hochschul-`n4`
 * ("Mathematik, Naturwissenschaften" — broader than expected).
 * Mapping inputs is therefore kept conservative on the school vocab,
 * while displaying labels uses DISPLAYNAME for full coverage.
 */
/**
 * Case-insensitive stable dedup. Some WLO nodes have:
 *   - duplicate URIs (data-side bug: `[Bio, Phys, Bio]`)
 *   - mixed-vocab entries that resolve to the same human concept
 *     (e.g. `Biologie` from school vocab + `Biologie` from Hochschul-vocab)
 * Both produce noisy duplicate labels in the output. Drop them, keeping
 * the first occurrence of each (case-insensitive).
 */
function dedupStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function resolveLabels(
  uris: string[] | undefined,
  displayNames: string[] | undefined,
  vocab: Parameters<typeof labelFromUri>[1],
): string[] {
  if (displayNames && displayNames.length > 0) {
    // Pair URIs with DISPLAYNAMEs and drop entries where the URI is a
    // vocabulary-root (e.g. ".../discipline/") — the index resolves those
    // to the vocabulary title ("Schulfächer") which is meaningless for UI.
    const cleaned: string[] = [];
    for (let i = 0; i < displayNames.length; i++) {
      const name = displayNames[i];
      if (typeof name !== 'string' || name.trim() === '') continue;
      const uri = uris?.[i] ?? '';
      if (uri && /\/$/.test(uri)) continue;  // ".../discipline/" root URI
      cleaned.push(name);
    }
    if (cleaned.length > 0) return dedupStable(cleaned);
  }
  if (!uris) return [];
  return dedupStable(
    uris
      .filter(u => !u || !/\/$/.test(u))    // also skip root URIs in fallback
      .map(u => labelFromUri(u, vocab))
  );
}

let _formatEnv: WloEnvironment = 'production';
export function setFormatEnvironment(env: WloEnvironment): void { _formatEnv = env; }

export function formatNode(node: WloNode): FormattedNode {
  const p = node.properties ?? {};
  const nodeId = node.ref?.id ?? first(p['sys:node-uuid']);
  const pageConfigRef = first(p['ccm:page_config_ref']);

  return {
    nodeId,
    title:                first(p['cclom:title']) || first(p['cm:name']) || node.name || node.title || '',
    description:          first(p['cclom:general_description']) || node.collection?.description || '',
    keywords:             p['cclom:general_keyword'] ?? [],
    disciplines:          resolveLabels(p['ccm:taxonid'],                    p['ccm:taxonid_DISPLAYNAME'],                    'discipline'),
    educationalContexts:  resolveLabels(p['ccm:educationalcontext'],         p['ccm:educationalcontext_DISPLAYNAME'],         'educationalContext'),
    userRoles:            resolveLabels(p['ccm:oeh_intended_end_user_role'], p['ccm:oeh_intended_end_user_role_DISPLAYNAME'], 'userRole'),
    learningResourceTypes:resolveLabels(p['ccm:oeh_lrt_aggregated'],         p['ccm:oeh_lrt_aggregated_DISPLAYNAME'],         'lrt'),
    url:                  first(p['ccm:wwwurl']) || node.content?.url || '',
    downloadUrl:          node.downloadUrl ?? '',
    contentUrl:           node.content?.url ?? '',
    previewUrl:           node.preview?.url ?? '',
    previewIsIcon:        node.preview?.isIcon ?? false,
    mimeType:             node.mimetype ?? '',
    fileSize:             node.size ?? 0,
    // Licenses don't have a server-side _DISPLAYNAME — keep local map.
    license:              labelFromUri(first(p['ccm:commonlicense_key']), 'license') || '',
    publisher:            first(p['ccm:oeh_publisher_combined']) || '',
    nodeType:             node.isDirectory === true ? 'collection' : 'content',
    topicPageUrl:         buildTopicPageUrl(_formatEnv, nodeId, pageConfigRef) ?? '',
  };
}

export function formatNodes(nodes: WloNode[]): FormattedNode[] {
  return nodes.map(formatNode);
}

/**
 * Render a structured JSON envelope. Use when the caller wants to parse fields
 * directly instead of regex-matching the markdown output.
 */
export function renderToJson(nodes: FormattedNode[], totalHits?: number): string {
  return JSON.stringify({
    total: totalHits ?? nodes.length,
    count: nodes.length,
    results: nodes,
  }, null, 2);
}

/** Render a list of FormattedNodes as a compact text format for LLM consumption. */
export function renderToText(nodes: FormattedNode[], totalHits?: number): string {
  const lines: string[] = [];
  if (totalHits !== undefined) {
    lines.push(`Gefundene Treffer gesamt: ${totalHits}, zeige ${nodes.length}\n`);
  }
  for (const n of nodes) {
    const parts: string[] = [];
    parts.push(`## ${n.title || '(kein Titel)'}`);
    parts.push(`nodeId: ${n.nodeId}`);
    if (n.description) parts.push(`Beschreibung: ${n.description.slice(0, 400)}${n.description.length > 400 ? '…' : ''}`);
    if (n.keywords.length)             parts.push(`Schlagworte: ${n.keywords.slice(0, 10).join(', ')}`);
    if (n.disciplines.length)          parts.push(`Fach: ${n.disciplines.join(', ')}`);
    if (n.educationalContexts.length)  parts.push(`Bildungsstufe: ${n.educationalContexts.join(', ')}`);
    if (n.userRoles.length)            parts.push(`Zielgruppe: ${n.userRoles.join(', ')}`);
    if (n.learningResourceTypes.length)parts.push(`Ressourcentyp: ${n.learningResourceTypes.join(', ')}`);
    if (n.url)                         parts.push(`URL: ${n.url}`);
    if (n.downloadUrl)                 parts.push(`Download: ${n.downloadUrl}`);
    if (n.contentUrl && n.contentUrl !== n.url) parts.push(`Render-URL: ${n.contentUrl}`);
    if (n.previewUrl)                  parts.push(`Vorschaubild: ${n.previewUrl}${n.previewIsIcon ? ' (Icon)' : ''}`);
    if (n.mimeType)                    parts.push(`MIME-Typ: ${n.mimeType}${n.fileSize ? ` (${Math.round(n.fileSize/1024)} KB)` : ''}`);
    if (n.license)                     parts.push(`Lizenz: ${n.license}`);
    if (n.publisher)                   parts.push(`Anbieter: ${n.publisher}`);
    if (n.topicPageUrl)                parts.push(`Themenseite: ${n.topicPageUrl}`);
    parts.push(`Typ: ${n.nodeType === 'collection' ? 'Sammlung' : 'Inhalt'}`);
    lines.push(parts.join('\n'));
    lines.push('');
  }
  return lines.join('\n').trim();
}
