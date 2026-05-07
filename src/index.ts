#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENDPOINT_PATTERN = /^https:\/\/api[a-z0-9.-]*\.sumologic\.com$/;
const MAX_SEARCH_DURATION_MS = 60_000;
const HTTP_TIMEOUT_MS = 30_000;
const MAX_RESULTS_LIMIT = 1000;
const RATE_LIMIT_RETRIES = 3;

interface Config {
  accessId: string;
  accessKey: string;
  endpoint: string;
}

function loadConfig(): Config {
  const accessId = process.env.SUMO_ACCESS_ID;
  const accessKey = process.env.SUMO_ACCESS_KEY;
  const endpoint = process.env.SUMO_ENDPOINT;

  const missing: string[] = [];
  if (!accessId) missing.push('SUMO_ACCESS_ID');
  if (!accessKey) missing.push('SUMO_ACCESS_KEY');
  if (!endpoint) missing.push('SUMO_ENDPOINT');
  if (missing.length > 0) {
    console.error(`sumo-mcp: missing required env var(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  if (!ENDPOINT_PATTERN.test(endpoint!)) {
    console.error(
      `sumo-mcp: SUMO_ENDPOINT must match ${ENDPOINT_PATTERN}. Got: ${endpoint}`,
    );
    process.exit(1);
  }

  return { accessId: accessId!, accessKey: accessKey!, endpoint: endpoint! };
}

function authHeader(config: Config): string {
  const token = Buffer.from(`${config.accessId}:${config.accessKey}`).toString(
    'base64',
  );
  return `Basic ${token}`;
}

class SumoError extends Error {
  constructor(public readonly userMessage: string, cause?: unknown) {
    super(userMessage);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SumoResponse {
  status: number;
  body: unknown;
}

async function sumoFetch(
  config: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<SumoResponse> {
  const url = `${config.endpoint}${path}`;
  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e?.name === 'AbortError') {
      throw new SumoError(`Sumo request timed out after ${HTTP_TIMEOUT_MS / 1000}s`);
    }
    throw new SumoError(`Failed to reach Sumo: ${e?.message ?? 'unknown error'}`, err);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

async function sumoFetchWithRetry(
  config: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<SumoResponse> {
  let attempt = 0;
  while (true) {
    const result = await sumoFetch(config, method, path, body);
    if (result.status !== 429) return result;
    if (attempt >= RATE_LIMIT_RETRIES) {
      throw new SumoError('Rate limited by Sumo.');
    }
    const backoffMs = 1000 * Math.pow(2, attempt);
    await sleep(backoffMs);
    attempt++;
  }
}

function mapError(status: number, body: unknown): SumoError {
  if (status === 401) {
    return new SumoError(
      'Authentication failed; check SUMO_ACCESS_ID and SUMO_ACCESS_KEY.',
    );
  }
  if (status === 403) {
    return new SumoError('Insufficient permissions for this query.');
  }
  if (status === 400) {
    const b = body as { message?: string; error?: string } | string | null;
    let detail: string;
    if (typeof b === 'string') {
      detail = b;
    } else if (b && typeof b === 'object') {
      detail = b.message ?? b.error ?? JSON.stringify(b);
    } else {
      detail = String(body);
    }
    return new SumoError(`Sumo rejected the query: ${detail}`);
  }
  return new SumoError(`Sumo returned HTTP ${status}: ${JSON.stringify(body)}`);
}

interface SearchInput {
  query: string;
  from?: string;
  to?: string;
  max_results?: number;
  timezone?: string;
}

interface TrimmedMessage {
  _messageTime: string;
  _sourceCategory?: string;
  _sourceHost?: string;
  _sourceName?: string;
  _raw: string;
}

async function searchLogs(
  config: Config,
  input: SearchInput,
): Promise<TrimmedMessage[]> {
  const max = Math.min(input.max_results ?? 100, MAX_RESULTS_LIMIT);
  const jobBody = {
    query: input.query,
    from: input.from ?? '-15m',
    to: input.to ?? 'now',
    timeZone: input.timezone ?? 'UTC',
  };

  const create = await sumoFetchWithRetry(
    config,
    'POST',
    '/api/v1/search/jobs',
    jobBody,
  );
  if (create.status >= 400) throw mapError(create.status, create.body);

  const createBody = create.body as { id?: string } | null;
  const jobId = createBody?.id;
  if (!jobId) {
    throw new SumoError(
      `Sumo did not return a job id. Response: ${JSON.stringify(create.body)}`,
    );
  }

  try {
    const start = Date.now();
    while (true) {
      if (Date.now() - start > MAX_SEARCH_DURATION_MS) {
        throw new SumoError(
          'Search did not complete within 60s. Try a smaller time range or simpler query.',
        );
      }
      const status = await sumoFetchWithRetry(
        config,
        'GET',
        `/api/v1/search/jobs/${jobId}`,
      );
      if (status.status >= 400) throw mapError(status.status, status.body);

      const statusBody = status.body as { state?: string } | null;
      if (statusBody?.state === 'DONE GATHERING RESULTS') break;
      if (statusBody?.state === 'CANCELLED') {
        throw new SumoError('Search job was cancelled by Sumo.');
      }

      const elapsed = Date.now() - start;
      const pollIntervalMs = elapsed < 10_000 ? 1000 : 5000;
      await sleep(pollIntervalMs);
    }

    const results = await sumoFetchWithRetry(
      config,
      'GET',
      `/api/v1/search/jobs/${jobId}/messages?offset=0&limit=${max}`,
    );
    if (results.status >= 400) throw mapError(results.status, results.body);

    const resultsBody = results.body as { messages?: unknown[] } | null;
    const rawMessages = resultsBody?.messages ?? [];
    return rawMessages.map((msg) => {
      const wrapper = msg as { map?: Record<string, string> } | null;
      const map = wrapper?.map ?? (msg as Record<string, string>) ?? {};
      return {
        _messageTime: map._messageTime ?? '',
        _sourceCategory: map._sourceCategory,
        _sourceHost: map._sourceHost,
        _sourceName: map._sourceName,
        _raw: map._raw ?? '',
      };
    });
  } finally {
    try {
      await sumoFetch(config, 'DELETE', `/api/v1/search/jobs/${jobId}`);
    } catch {
      // best-effort cleanup; intentionally swallowed
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({
    name: 'sumo-mcp',
    version: '0.1.0',
  });

  server.tool(
    'search_logs',
    'Run a Sumo Logic search and return matching log lines. Use this to investigate production issues, find errors, trace events, or look up activity in logs. Returns trimmed messages with timestamp, source category, host, source name, and raw log line.',
    {
      query: z.string().describe('Sumo Logic search expression (e.g. `_sourceCategory=prod/api error`).'),
      from: z
        .string()
        .optional()
        .describe('Start time. ISO 8601 (e.g. "2026-05-07T10:00:00") or Sumo relative ("-15m", "-1h", "-1d", "now"). Default "-15m".'),
      to: z
        .string()
        .optional()
        .describe('End time. Same format as `from`. Default "now".'),
      max_results: z
        .number()
        .int()
        .positive()
        .max(MAX_RESULTS_LIMIT)
        .optional()
        .describe(`Max messages to return. Default 100, capped at ${MAX_RESULTS_LIMIT}.`),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone name for the search (e.g. "UTC", "Europe/London"). Default "UTC".'),
    },
    async (args) => {
      try {
        const messages = await searchLogs(config, args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof SumoError
            ? err.userMessage
            : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
        return {
          isError: true,
          content: [{ type: 'text', text: message }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('sumo-mcp: connected via stdio');
}

main().catch((err) => {
  console.error('sumo-mcp: fatal error:', err);
  process.exit(1);
});
