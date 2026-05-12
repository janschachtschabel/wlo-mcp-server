/**
 * http.ts – HTTP server entry point (for Docker / self-hosted).
 * Implements MCP Streamable HTTP transport on POST /mcp.
 * Run: WLO_REPOSITORY_URL=https://redaktion.openeduhub.net/edu-sharing PORT=3000 \
 *        node dist/http.js
 */

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { WLO_REPOSITORY_URL } from './wlo-api.js';

const PORT = Number(process.env['PORT'] ?? 3000);

const httpServer = http.createServer(async (req, res) => {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'wlo-mcp', version: '1.0.0' }));
    return;
  }

  // MCP endpoint – stateless: new server + transport per request
  if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf-8');

    let body: unknown;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const server    = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    await server.close();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Use POST /mcp' }));
});

httpServer.listen(PORT, () => {
  console.log(`WLO MCP Server listening on http://localhost:${PORT}/mcp`);
  console.log(`Repository: ${WLO_REPOSITORY_URL}`);
});
