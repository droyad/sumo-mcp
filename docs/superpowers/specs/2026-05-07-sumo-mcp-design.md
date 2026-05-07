# Sumo MCP — Design

**Date:** 2026-05-07
**Project:** sumo-mcp
**Location:** `C:\Source\SumoMcp`

## Goal

A minimal MCP server that lets Claude Code run Sumo Logic searches and retrieve raw log results.

Replacement for two community options that were evaluated and rejected: `samwang0723/mcp-sumologic` (HTTP-transport overhead — needs a separately managed long-lived process) and `vinit-devops/sumologic_mcp` (PyPI metadata and README point at a non-existent `github.com/sumologic/sumologic-mcp-python` repo while being maintained from a personal Gmail — code is structurally clean, but provenance is misleading enough to fail the bar for credential-handling code).

## Non-goals

- No dashboard, monitor, collector, metrics, or admin tools
- No aggregated query results (e.g., `... | count by host`) — raw messages only
- No multi-step search orchestration — single blocking tool
- No formal test suite for the initial cut

## Architecture

stdio MCP server, one tool, ~150 lines of TypeScript. Spawned as a subprocess by Claude Code on demand.

```
SumoMcp/
├── src/index.ts        all source
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore
```

## Tool surface

One tool: `search_logs`

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `query` | string | required | Sumo Logic search expression |
| `from` | string | `"-15m"` | ISO 8601 (`"2026-05-07T10:00:00"`), epoch ms, or relative (`"now"`, `"-<N>{s,m,h,d,w}"`). Sumo's API only accepts ISO 8601 / epoch ms, so relative values are translated to epoch ms before send |
| `to` | string | `"now"` | Same format rules as `from` |
| `max_results` | number | 100 | Capped at 1000 |
| `timezone` | string | `"UTC"` | Sent to Sumo as the search timezone |

Returns a JSON array of messages, each trimmed to:

- `_messageTime` (ISO timestamp)
- `_sourceCategory`
- `_sourceHost`
- `_sourceName`
- `_raw` (the log line)

All other fields Sumo returns are dropped. Sumo emits ~25 fields per message; most are noise for log analysis and bloat the response.

## Sumo API flow

Standard async search-job dance:

1. `POST {endpoint}/api/v1/search/jobs` with `{ query, from, to, timeZone }` → `{ id }`
2. Poll `GET {endpoint}/api/v1/search/jobs/{id}` every 1s for the first 10s, then every 5s — until `state === "DONE GATHERING RESULTS"` or the hard 60s timeout
3. `GET {endpoint}/api/v1/search/jobs/{id}/messages?offset=0&limit={max_results}`
4. `DELETE {endpoint}/api/v1/search/jobs/{id}` — best-effort, non-fatal if it fails

Auth on every request: `Authorization: Basic ${base64(access_id + ':' + access_key)}`.

Sumo uses sticky sessions for the search-job lifecycle: cookies set on the POST response must accompany the polling and result-fetch requests, otherwise follow-ups return `404 searchjob.jobid.invalid` (the request lands on a node that doesn't know about the job). A per-job in-memory cookie jar carries them through the four calls.

## Configuration

Three required env vars validated at startup. If any are missing or invalid, the server logs a clear error and exits with code 1 before opening the MCP transport.

| Env var | Notes |
|---------|-------|
| `SUMO_ACCESS_ID` | Sumo Logic Access ID |
| `SUMO_ACCESS_KEY` | Sumo Logic Access Key |
| `SUMO_ENDPOINT` | Must match `^https://api[a-z0-9.-]*\.sumologic\.com$` — defensive check so creds can't be sent to an attacker-controlled host via misconfig |

## Error handling

| Condition | Response to Claude |
|-----------|--------------------|
| Sumo 401 | "Authentication failed; check SUMO_ACCESS_ID and SUMO_ACCESS_KEY." |
| Sumo 403 | "Insufficient permissions for this query." |
| Sumo 400 | "Sumo rejected the query: {body.message}" |
| Sumo 429 | Retry with backoff (1s, 2s, 4s); fail after 3 attempts with "Rate limited by Sumo." |
| Network error | "Failed to reach Sumo: {message}" |
| Search exceeds 60s | Attempt to delete the job; return "Search did not complete within 60s. Try a smaller time range or simpler query." |

Per-request HTTP timeout: 30s.

## Dependencies

Runtime:

- `@modelcontextprotocol/sdk` (latest 1.x)

Dev:

- `typescript`
- `@types/node`

No HTTP client dep — Node 18+ ships native `fetch`.

## Build and run

- `npm run build` → `tsc` outputs to `dist/`
- Entry: `node dist/index.js`
- Transport: stdio

## Wiring into Claude Code

```
claude mcp add --scope user sumo `
  --env SUMO_ACCESS_ID=... `
  --env SUMO_ACCESS_KEY=... `
  --env SUMO_ENDPOINT=https://api.us2.sumologic.com `
  -- node C:\Source\SumoMcp\dist\index.js
```

## Testing

Initial cut: manual smoke test only.

1. Valid creds + known-good query — confirm results returned
2. Bad query syntax — confirm 400 path produces a clear error
3. Wrong access key — confirm 401 path produces a clear error

`vitest` can be added later if the project grows beyond the single tool.
