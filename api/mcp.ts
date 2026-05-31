/**
 * api/mcp.ts – Vercel serverless function for the WLO MCP server.
 * Implements Streamable HTTP transport (stateless, one server per request).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../src/server.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json({ status: 'ok', server: 'wlo-mcp', version: '1.0.0' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    // Normalize the Accept header so ANY client works — including simple ones
    // (curl, MCP Inspector, some IDE integrations) that send only
    // "application/json". The MCP SDK's POST handler hard-requires BOTH
    // application/json AND text/event-stream (→ 406 otherwise); since we reply
    // with a single JSON body (enableJsonResponse), forcing both is harmless.
    // NOTE: the underlying @hono/node-server builds the Web Request from
    // `rawHeaders` (not the parsed `headers` object), so we patch rawHeaders.
    {
      const WANT = 'application/json, text/event-stream';
      const rh = req.rawHeaders;
      let patched = false;
      for (let i = 0; i < rh.length; i += 2) {
        if (rh[i]?.toLowerCase() === 'accept') { rh[i + 1] = WANT; patched = true; }
      }
      if (!patched) rh.push('Accept', WANT);
      req.headers['accept'] = WANT;
    }

    const server    = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless – required for Vercel serverless
      enableJsonResponse: true,      // reply with one JSON body instead of an SSE
                                     // stream — robust on serverless (no stream
                                     // torn down by the immediate server.close()).
    });

    await server.connect(transport);
    // req.body is already parsed by Vercel's default JSON middleware
    await transport.handleRequest(req, res, req.body);
    await server.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    }
  }
}
