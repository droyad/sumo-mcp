# sumo-mcp

Minimal MCP server that exposes a single `search_logs` tool for Sumo Logic.

## Build

```powershell
npm install
npm run build
```

## Configure in Claude Code

## API Key
In Sumo:
- Click on your username and select `Personal Access Keys`
- Click `Add New Access Key`
- Enter a name, e.g. `Claude Local`
- Select `Custom` under scope
- Check `Run Log Search` under the `Log Search` section
- Save the key

## Install

```powershell
claude mcp add --scope user sumo `
  --env SUMO_ACCESS_ID=<your-access-id> `
  --env SUMO_ACCESS_KEY=<your-access-key> `
  --env SUMO_ENDPOINT=https://api.us2.sumologic.com `
  -- node C:\Source\SumoMcp\dist\index.js
```

`SUMO_ENDPOINT` must match `https://api.*.sumologic.com`. Pick the host for your Sumo deployment region (US2, EU, AU, etc.).

## Tool

`search_logs(query, from?, to?, max_results?, timezone?)`

- `query` — Sumo search expression
- `from` / `to` — ISO 8601 or Sumo relative (`-15m`, `-1h`, `now`). Default `-15m` / `now`
- `max_results` — default 100, capped at 1000
- `timezone` — IANA name, default `UTC`

Returns a JSON array of messages with `_messageTime`, `_sourceCategory`, `_sourceHost`, `_sourceName`, `_raw`.

Hard timeout 60s — narrow the time range or query if you hit it.

## Design

See `docs/superpowers/specs/2026-05-07-sumo-mcp-design.md`.
