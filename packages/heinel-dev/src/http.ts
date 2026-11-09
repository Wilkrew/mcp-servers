#!/usr/bin/env -S node --experimental-strip-types
// Serves the stateless endpoint at http://localhost:<PORT>/mcp with Node's
// own http module. For production, put the same handler behind your host's
// HTTPS and rate limits.

import { createServer } from 'node:http'
import { handleMcp } from './handler.ts'

const port = Number(process.env.PORT ?? 3333)
const MAX_BODY = 64 * 1024

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found. The MCP endpoint is /mcp.')
    return
  }
  const body: Buffer[] = []
  let size = 0
  for await (const part of req) {
    size += (part as Buffer).length
    if (size > MAX_BODY) {
      res.writeHead(413).end('Request too large')
      return
    }
    body.push(part as Buffer)
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const request = new Request(url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(body)
  })
  const response = await handleMcp(request)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(port, () => console.error(`heinel-dev MCP on http://localhost:${port}/mcp`))
