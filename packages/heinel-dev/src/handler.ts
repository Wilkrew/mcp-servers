// A stateless Streamable HTTP endpoint built on web-standard Request and
// Response, so the same handler runs in Node, an edge function or a worker.
// Each request gets a fresh server and transport; there are no sessions,
// nothing is stored, and all content is public.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer } from './server.ts'

const MAX_BODY = 64 * 1024

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless: send JSON-RPC as POST.' }, id: null },
      { status: 405, headers: { allow: 'POST' } }
    )
  }
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY) return new Response('Request too large', { status: 413 })

  const server = createServer()
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    // JSON responses are complete once returned, so the pair can close.
    void transport.close()
    void server.close()
  }
}
