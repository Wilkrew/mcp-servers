# sl-departures-mcp

Live departures, stops, stop layouts, disruptions and trip plans in Stockholm public transport, for any MCP client. It uses SL's open APIs, which need no key.

## Tools

| Tool | What it does |
|---|---|
| `find_stop` | Stops by name. Works without å, ä and ö, and puts the plain stop before replacement-traffic variants |
| `nearby_stops` | Stops within a radius of a position, nearest first |
| `get_departures` | Real-time departures from a stop by name or site id: line, destination, platform, expected time, delay, cancellations and notices. Filter by mode, line, direction and how far ahead |
| `get_disruptions` | Current notices for a stop, a line or a mode, most important first. `future` adds planned work |
| `plan_trip` | Trips from A to B, by stop name, site id or `"lat,lon"`: each leg with line, direction, platform, Stockholm times, delay, stops and notices, plus walks and changes, and where to board. Leave at or arrive by a time, prefer fewer changes or less walking, avoid modes |
| `stop_layout` | Where a stop's platforms, bus stop letters and quays are: designation, type, position, direction and distance from the stop centre, entrance, and the lines leaving from each in the next hour. For a map or walking directions; SL publishes no indoor station plans |

When a name matches more than one stop, `get_departures` and `plan_trip` say which stop they used and list the others, so the assistant can ask. In `plan_trip`, each ride has `live: true` when SL tracks it in real time and `live: false` when it follows the timetable; `all_live` sums that up per trip. `platform_position` is where to board, when SL sends it. Walks have `in_station: true` when they are a change inside a station.

## Run it

```bash
npm start
```

See the root README for adding it to Claude Code or Claude Desktop. A hosted copy runs at `https://heinel.dev/sl/mcp`, with nothing to install.

## Behaviour

- **APIs:** [SL Transport](https://www.trafiklab.se/sv/api/other-apis/sl/transport/) for stops, stop points and departures, [SL Deviations](https://www.trafiklab.se/api/other-apis/sl/deviations/) for notices, and [SL Journey Planner v2](https://www.trafiklab.se/api/other-apis/sl/journey-planner-2/) for trips. A stop's site id becomes the planner's 16-digit id (9117 → `9091001000009117`), so both tools match stops the same way.
- **Caching:** the stop list (about 6,500 stops) and the stop point list for 24 hours, notices for 60 seconds (SL asks for at most one request a minute), trips for 30 seconds and departures for 20 seconds. Trips are asked for without leg coordinates, which keeps answers small.
- **Timeouts:** 10 seconds per request. An SL error comes back as a tool error with the status.
- **Avoiding modes:** the journey planner ignores `incl_mot_N=false` unless the modes to keep are sent as `true`, so the server sends all of them. SL still returned a pendeltåg trip on one route with pendeltåg left out, so the server also drops any trip that uses an avoided mode.
- **Stop layouts:** the stop point list (about 14,000 points, 8 MB) is fetched on the first `stop_layout` call and cached for a day. Retired bus stop positions that SL keeps with designations like `OLD` are left out.
- **Times** are local Stockholm time. Departures come that way from SL; the journey planner sends UTC, which the server converts. Delay is expected minus scheduled, in minutes.
- **Language:** SL writes most notices in Swedish. The server picks an English version when there is one and otherwise tells the assistant to translate.

## Tests

`test/fixtures/` holds trimmed real responses from SL, recorded on 6 and 17 November 2026, including a cancelled departure, a delay notice, trips with walks and changes inside a station, and Odenplan's platforms and bus stop letters. A fake `fetch` serves them, so the tests check how URLs are built, the filters, caching and errors without calling SL.

To check a tool against SL and record new answers:

```bash
npm run try -- plan_trip from=Odenplan to=Slussen --save
npm run try -- stop_layout stop=Odenplan --save
```

`key=value` passes a string and `key:=value` passes JSON, such as `trips:=2`. The script prints the tool's answer, and `--save` writes each raw SL response to `test/fixtures/live/` (git-ignored), ready to trim into a fixture.

## Data

Data from SL through Trafiklab. SL's [licence terms](https://www.trafiklab.se/sv/api/other-apis/sl/licence/) ask every service to credit Trafiklab, so each answer has a `source` field, "Based on information retrieved from Trafiklab.se (SL).", and the server's instructions ask the assistant to pass it on. Lists come back as `{ results, source }`.
