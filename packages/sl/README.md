# sl-departures-mcp

Live departures, stops and disruptions in Stockholm public transport, for any MCP client. It uses SL's open APIs, which need no key.

## Tools

| Tool | What it does |
|---|---|
| `find_stop` | Stops by name. Works without å, ä and ö, and puts the plain stop before replacement-traffic variants |
| `nearby_stops` | Stops within a radius of a position, nearest first |
| `get_departures` | Real-time departures from a stop by name or site id: line, destination, platform, expected time, delay, cancellations and notices. Filter by mode, line, direction and how far ahead |
| `get_disruptions` | Current notices for a stop, a line or a mode, most important first. `future` adds planned work |

When a name matches more than one stop, `get_departures` says which stop it used and lists the others, so the assistant can ask.

## Run it

```bash
npm start
```

See the root README for adding it to Claude Code or Claude Desktop.

## Behaviour

- **APIs:** [SL Transport](https://www.trafiklab.se/sv/api/other-apis/sl/transport/) for stops and departures, and [SL Deviations](https://www.trafiklab.se/api/other-apis/sl/deviations/) for notices.
- **Caching:** the stop list (about 6,500 stops) for 24 hours, notices for 60 seconds (SL asks for at most one request a minute), and departures for 20 seconds.
- **Timeouts:** 10 seconds per request. An SL error comes back as a tool error with the status.
- **Times** are local Stockholm time, as SL sends them. Delay is expected minus scheduled, in minutes.
- **Language:** SL writes most notices in Swedish. The server picks an English version when there is one and otherwise tells the assistant to translate.

## Tests

`test/fixtures/` holds trimmed real responses from SL, recorded on 6 November 2026, including a cancelled departure and a delay notice. A fake `fetch` serves them, so the tests check how URLs are built, the filters, caching and errors without calling SL.

## Data

Data from SL through Trafiklab. See SL's [licence terms](https://www.trafiklab.se/sv/api/other-apis/sl/licence/).
