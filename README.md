# mcp-servers

Two [Model Context Protocol](https://modelcontextprotocol.io) servers in TypeScript. Each one lets an AI assistant, such as Claude, Cursor or any other MCP client, use a data source through a few well-described tools.

| Server | What it answers | Data |
|---|---|---|
| [`heinel-dev`](packages/heinel-dev) | Questions about my work: roles, projects, case studies, skills, what others say | The public content of [heinel.dev](https://heinel.dev), bundled |
| [`sl`](packages/sl) | "When's the next metro from Slussen?", "Any disruptions on line 17?" | SL's open APIs for Stockholm public transport, live |

```text
you ── "Has Filip used vector search?" ──▶ assistant ──search──▶ heinel-dev
you ── "Next train from Odenplan?" ──────▶ assistant ──get_departures──▶ sl ──▶ SL API
```

## Try it without installing

The `heinel-dev` server also runs on heinel.dev itself, as a stateless Streamable HTTP endpoint:

```text
https://heinel.dev/mcp
```

In Claude, add it as a custom connector with that URL. In Claude Code:

```bash
claude mcp add --transport http heinel-dev https://heinel.dev/mcp
```

The hosted copy is built from the site's own content files, so it answers from the same text as the pages. It's read-only, keeps no sessions and is rate-limited.

## Quick start

Needs Node.js 22.18 or later. There's no build step: Node runs the TypeScript directly.

```bash
npm install
npm test
```

**Claude Code:**

```bash
claude mcp add heinel-dev -- node --experimental-strip-types /path/to/mcp-servers/packages/heinel-dev/src/stdio.ts
claude mcp add sl -- node --experimental-strip-types /path/to/mcp-servers/packages/sl/src/stdio.ts
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "heinel-dev": { "command": "node", "args": ["--experimental-strip-types", "/path/to/mcp-servers/packages/heinel-dev/src/stdio.ts"] },
    "sl": { "command": "node", "args": ["--experimental-strip-types", "/path/to/mcp-servers/packages/sl/src/stdio.ts"] }
  }
}
```

## How they're built

- **The official SDK.** `@modelcontextprotocol/sdk` with `zod` schemas, so every tool's input is validated before it runs.
- **Read-only.** Every tool is annotated `readOnlyHint`, and none can change anything.
- **Tool descriptions are the interface.** The model picks a tool from its name and description alone, so they say what comes back and when to use it.
- **Outside text is data.** Each server tells the model to treat content from the source (site text, SL's notices) as data, never as instructions.
- **Errors the model can act on.** An unknown stop or role comes back as a tool error that names the alternatives, not as a crash.
- **Tested through a real client.** The tests connect an MCP client to each server, in memory and over stdio, and call the tools the way an assistant would. The SL tests replay trimmed real responses from SL, so they never call the network.
- **Fair to the source.** The SL server caches the stop list for a day, disruptions for a minute (SL's fair-use limit) and departures for 20 seconds.

## Layout

```text
packages/
  heinel-dev/   src/  data/site.json  scripts/export-site.ts  test/
  sl/           src/  test/fixtures/
```

CI runs the type check and all tests on every push and pull request.

## Related

I've also built a read-only MCP server for my private trip planner. It decrypts exported trip files locally and never reads the dietary or allergy notes in them.

## Licence

MIT. The data each server reads belongs to its source: heinel.dev's content is mine, and SL's data comes under SL's own terms.
