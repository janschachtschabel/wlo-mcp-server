/**
 * formatter.ts – Extract and clean WLO node properties into a structured output.
 */

import type { WloNode } from './wlo-api.js';
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
  url: string;
  previewUrl: string;
  license: string;
  publisher: string;
}

function first(arr: string[] | undefined): string {
  return arr?.[0] ?? '';
}

function resolveLabels(uris: string[] | undefined, vocab: Parameters<typeof labelFromUri>[1]): string[] {
  return (uris ?? []).map(u => labelFromUri(u, vocab));
}

export function formatNode(node: WloNode): FormattedNode {
  const p = node.properties ?? {};
  const nodeId = node.ref?.id ?? first(p['sys:node-uuid']);

  return {
    nodeId,
    title:                first(p['cclom:title']) || first(p['cm:name']) || node.name || node.title || '',
    description:          first(p['cclom:general_description']) || node.collection?.description || '',
    keywords:             p['cclom:general_keyword'] ?? [],
    disciplines:          resolveLabels(p['ccm:taxonid'], 'discipline'),
    educationalContexts:  resolveLabels(p['ccm:educationalcontext'], 'educationalContext'),
    userRoles:            resolveLabels(p['ccm:oeh_intended_end_user_role'], 'userRole'),
    learningResourceTypes:resolveLabels(p['ccm:oeh_lrt_aggregated'], 'lrt'),
    url:                  first(p['ccm:wwwurl']) || node.content?.url || '',
    previewUrl:           (!node.preview?.isIcon ? node.preview?.url : '') ?? '',
    license:              first(p['ccm:commonlicense_key']) || '',
    publisher:            first(p['ccm:oeh_publisher_combined']) || '',
  };
}

export function formatNodes(nodes: WloNode[]): FormattedNode[] {
  return nodes.map(formatNode);
}

/** Render a list of FormattedNodes as a compact JSON string for LLM consumption. */
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
    if (n.previewUrl)                  parts.push(`Vorschaubild: ${n.previewUrl}`);
    if (n.license)                     parts.push(`Lizenz: ${n.license}`);
    if (n.publisher)                   parts.push(`Anbieter: ${n.publisher}`);
    lines.push(parts.join('\n'));
    lines.push('');
  }
  return lines.join('\n').trim();
}
