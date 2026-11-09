#!/usr/bin/env -S node --experimental-strip-types
// Runs the server over stdio, for Claude Code, Claude Desktop and other local clients.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.ts'

await createServer().connect(new StdioServerTransport())
