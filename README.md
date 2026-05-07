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

The commands below prompt for the access ID and key interactively so the secrets never appear on the command line or in shell history.

`SUMO_ENDPOINT` must match `https://api.*.sumologic.com`. Pick the host for your Sumo deployment region (US2, EU, AU, etc.).

### PowerShell

```powershell
$accessId = Read-Host "Sumo Access ID"
$accessKey = [System.Net.NetworkCredential]::new('', (Read-Host "Sumo Access Key" -AsSecureString)).Password

claude mcp add --scope user sumo `
  --env SUMO_ACCESS_ID=$accessId `
  --env SUMO_ACCESS_KEY=$accessKey `
  --env SUMO_ENDPOINT=https://api.us2.sumologic.com `
  -- node C:\Source\SumoMcp\dist\index.js

Remove-Variable accessId, accessKey
```

### Bash

```bash
read -r -p "Sumo Access ID: " SUMO_ACCESS_ID
read -r -s -p "Sumo Access Key: " SUMO_ACCESS_KEY
echo

SUMO_ACCESS_ID="$SUMO_ACCESS_ID" SUMO_ACCESS_KEY="$SUMO_ACCESS_KEY" \
  claude mcp add --scope user sumo \
    --env SUMO_ACCESS_ID="$SUMO_ACCESS_ID" \
    --env SUMO_ACCESS_KEY="$SUMO_ACCESS_KEY" \
    --env SUMO_ENDPOINT=https://api.us2.sumologic.com \
    -- node /path/to/sumo-mcp/dist/index.js

unset SUMO_ACCESS_ID SUMO_ACCESS_KEY
```

## Tool

`search_logs(query, from?, to?, max_results?, timezone?)`

- `query` — Sumo search expression
- `from` / `to` — ISO 8601 without timezone designator (`2026-05-07T10:00:00`), epoch milliseconds, or relative shorthand `now` / `-<N><unit>` where unit is `s|m|h|d|w` (e.g. `-15m`, `-1h`, `-7d`). Relative values are translated to epoch milliseconds before being sent to Sumo. Default `-15m` / `now`
- `max_results` — default 100, capped at 1000
- `timezone` — IANA name, default `UTC` (used when `from`/`to` are ISO 8601 without an explicit offset)

Returns a JSON array of messages with `_messageTime`, `_sourceCategory`, `_sourceHost`, `_sourceName`, `_raw`.

Hard timeout 60s — narrow the time range or query if you hit it.

## Design

See `docs/superpowers/specs/2026-05-07-sumo-mcp-design.md`.
