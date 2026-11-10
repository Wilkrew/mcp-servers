# heinel-dev-mcp

Ask your AI assistant about my work. The server answers from the public content of [heinel.dev](https://heinel.dev): roles, projects, case studies, skills, the character sheet and recommendations. Every answer can link back to the page it came from.

## Tools, resource and prompt

| | Name | What it does |
|---|---|---|
| Tool | `about` | Headline, key facts, what I do now, and contact details |
| Tool | `list_experience` | Roles, newest first; `career` or `earlier` |
| Tool | `get_experience` | One role in full |
| Tool | `list_work` | Client work, methods and own projects, with links to case studies |
| Tool | `get_case` | A full case study: problem, constraints, role, decisions, result |
| Tool | `get_skills` | Stack, proficiencies, courses and languages |
| Tool | `get_recommendations` | What people I've worked with say |
| Tool | `search` | BM25 keyword search across all of it, with previews and links |
| Resource | `heinel://site.json` | All the content as one JSON document |
| Prompt | `role_fit` | Compares my experience with a job ad or brief: matches with evidence, then gaps |

## Run it

Hosted, with nothing to install: `https://heinel.dev/mcp` (see the root README).

Locally, over stdio (see the root README for client setup):

```bash
npm start
```

Or as a stateless HTTP endpoint at `http://localhost:3333/mcp`:

```bash
npm run serve
```

`src/handler.ts` uses web-standard `Request` and `Response`, so the same handler can run in an edge function or a worker. Each request gets a fresh server; there are no sessions and nothing is stored.

## The data

`data/site.json` is generated from the site's own content files, never written by hand:

```bash
npm run export-site -- ../heinel-site
```

It holds only what the public site shows: visible roles and projects, the public case pages, and the contact details the site publishes. Hidden entries, unlisted pages and the date of birth stay out, and a test checks for phone numbers and unlisted pages.

The search is a small BM25 index over about 80 chunks: one per role, project, case section and sheet entry. Matching ignores å, ä and ö, so "affarsvarlden" finds Affärsvärlden.
