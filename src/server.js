/**
 * alice-ai-hermes-proxy v2.1
 * OpenAI-compatible proxy for Alice AI / YandexGPT (Yandex Cloud AI Studio).
 *
 * Changelog v2.1:
 *   + Token usage is now counted for STREAMING responses too (SSE usage tap:
 *     the piped body passes a memory-bounded Transform that keeps the last
 *     ~64 KB and records the final `usage` chunk). Client stream is untouched.
 *   + stream_requests counter (streaming upstream responses) in /healthz and /metrics/tokens
 *
 * Changelog v2.0:
 *   + Token usage tracking per model (/metrics/tokens)
 *   + Response cache for identical non-streaming requests
 *   + Rate limiting (per IP, configurable RPM)
 *   + Request size limit (estimated tokens + body size)
 *   + Graceful shutdown (SIGTERM → drain connections)
 *   + Estimated token count in access log
 *   + History trimming for oversized contexts
 *   + Tool schema size estimation and warning
 *
 * Auth modes (pick ONE): API_KEY | IAM_TOKEN | SA_JSON / SA_JSON_PATH
 *
 * Endpoints:
 *   GET  /healthz              — liveness + stats + token counters
 *   GET  /metrics/tokens       — detailed token usage per model
 *   GET  /v1/models            — live upstream catalog (cached)
 *   GET  /v1/models/:id        — single model info
 *   POST /v1/chat/completions  — chat (stream + tools)
 *   POST /v1/completions       — legacy completions
 *   POST /v1/embeddings        — embeddings
 */

require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ===================================================================
//  CONFIG
// ===================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const YC_BASE = process.env.YC_BASE_URL || 'https://ai.api.cloud.yandex.net/v1';
const FOLDER_ID = process.env.FOLDER_ID || process.env.YC_FOLDER_ID || '';

if (!FOLDER_ID) console.error('[proxy] FOLDER_ID is not set. Requests will fail.');

// --- Limits ---
const MAX_REQUEST_TOKENS   = parseInt(process.env.MAX_REQUEST_TOKENS || '100000', 10);
const MAX_BODY_BYTES       = parseInt(process.env.MAX_BODY_BYTES || '4194304', 10);   // 4 MB
const RATE_LIMIT_RPM       = parseInt(process.env.RATE_LIMIT_RPM || '60', 10);
const CACHE_TTL_MS         = parseInt(process.env.CACHE_TTL_MS || '300000', 10);       // 5 min
const CACHE_MAX_ENTRIES    = parseInt(process.env.CACHE_MAX_ENTRIES || '200', 10);
const MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES || '50', 10);
const MODEL_CACHE_TTL_SEC  = parseInt(process.env.MODEL_CACHE_TTL_SEC || '300', 10);
const UPSTREAM_TIMEOUT_MS  = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '120000', 10);
const UPSTREAM_RETRIES     = parseInt(process.env.UPSTREAM_RETRIES || '1', 10);
const ACCESS_LOG           = process.env.PROXY_ACCESS_LOG !== '0';

// --- Fallback model list ---
const MODELS = (process.env.PROXY_MODELS ||
  'aliceai-llm/latest,aliceai-llm-flash/latest,yandexgpt-5-pro/latest,yandexgpt-5.1/latest,yandexgpt-5-lite/latest,yandexgpt/latest,yandexgpt-lite/latest,deepseek-v4-flash/latest,qwen3-235b-a22b-fp8/latest,qwen3.6-35b-a3b/latest,gpt-oss-120b/latest,gpt-oss-20b/latest')
  .split(',').map(s => s.trim()).filter(Boolean);

// --- Context windows ---
const MODEL_CONTEXT = {
  'aliceai-llm': 131072,
  'aliceai-llm-flash': 65536,
  'yandexgpt-5.1': 32768,
  'yandexgpt-5-pro': 32768,
  'yandexgpt-5-lite': 32768,
  'yandexgpt': 32768,
  'yandexgpt-lite': 32768,
  'yandexgpt-32k': 32768,
  'deepseek-v4-flash': 1048576,
  'qwen3-235b-a22b-fp8': 262144,
  'qwen3.6-35b-a3b': 262144,
  'gpt-oss-120b': 131072,
  'gpt-oss-20b': 131072,
  'speech-realtime-260528': 65536,
  'speech-realtime-250923': 32768,
  'speech-realtime-deepseek-v4-flash': 1048576,
};

// ===================================================================
//  IAM TOKEN MANAGER
// ===================================================================

const API_KEY     = process.env.API_KEY || process.env.YC_API_KEY || '';
const IAM_TOKEN   = process.env.IAM_TOKEN || '';
const SA_JSON     = process.env.SA_JSON || '';
const SA_JSON_PATH = process.env.SA_JSON_PATH || '';
const REFRESH_MIN = parseInt(process.env.TOKEN_REFRESH_INTERVAL_MIN || '55', 10);

let cachedIamToken = '';
let lastRefreshAt  = 0;

function loadServiceAccountKey() {
  if (SA_JSON) return JSON.parse(SA_JSON);
  if (SA_JSON_PATH) return JSON.parse(require('fs').readFileSync(SA_JSON_PATH, 'utf8'));
  return null;
}

function createServiceAccountJwt(saKey) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { aud: 'https://iam.api.cloud.yandex.net/iam/v1/tokens:exchange', iss: saKey.service_account_id, iat: now, exp: now + 3600 },
    saKey.private_key,
    { algorithm: 'PS256', header: { alg: 'PS256', typ: 'JWT', kid: saKey.id } }
  );
}

async function exchangeJwtForIamToken(jwtToken) {
  const res = await fetch('https://iam.api.cloud.yandex.net/iam/v1/tokens:exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jwt: jwtToken }),
  });
  if (!res.ok) throw new Error(`IAM exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).iamToken;
}

async function refreshIamToken() {
  const saKey = loadServiceAccountKey();
  if (!saKey) return;
  cachedIamToken = await exchangeJwtForIamToken(createServiceAccountJwt(saKey));
  lastRefreshAt = Date.now();
  console.log('[proxy] IAM token refreshed at', new Date().toISOString());
}

async function getIamToken() {
  if (IAM_TOKEN) return IAM_TOKEN;
  if (!cachedIamToken || Date.now() - lastRefreshAt > REFRESH_MIN * 60 * 1000) await refreshIamToken();
  return cachedIamToken;
}

async function authHeader() {
  return API_KEY ? `Api-Key ${API_KEY}` : `Bearer ${await getIamToken()}`;
}

// ===================================================================
//  TOKEN USAGE TRACKER
// ===================================================================

const tokenStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  requestsWithUsage: 0,
  streamRequests: 0,
  cacheHits: 0,
  requestsRejected: 0,
  byModel: {},
};

function recordUsage(model, usage) {
  if (!usage) return;
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  tokenStats.totalPromptTokens += pt;
  tokenStats.totalCompletionTokens += ct;
  tokenStats.totalTokens += pt + ct;
  tokenStats.requestsWithUsage += 1;

  const base = String(model || '').split('/').pop() || 'unknown';
  if (!tokenStats.byModel[base]) tokenStats.byModel[base] = { prompt: 0, completion: 0, total: 0, requests: 0 };
  tokenStats.byModel[base].prompt += pt;
  tokenStats.byModel[base].completion += ct;
  tokenStats.byModel[base].total += pt + ct;
  tokenStats.byModel[base].requests += 1;

  if (ACCESS_LOG) console.log(`[proxy] tokens model=${base} prompt=${pt} completion=${ct} total=${pt + ct}`);
}

/**
 * v2.1: extract the last SSE `data:` chunk that carries a `usage` object.
 * Yandex/OpenAI send it as the final chunk when the client asks for
 * stream_options.include_usage. We scan backwards so a trailing
 * `data: [DONE]` (or a truncated tail) never shadows the usage chunk.
 */
function extractUsageFromSse(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj && obj.usage) return obj.usage;
    } catch { /* partial / oversized chunk — keep scanning backwards */ }
  }
  return null;
}

// ===================================================================
//  RATE LIMITER  (simple sliding window per IP)
// ===================================================================

const rateBuckets = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > 60000) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return true;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_RPM;
}

// Periodic cleanup of stale buckets (every 5 min)
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, b] of rateBuckets) {
    if (b.start < cutoff) rateBuckets.delete(ip);
  }
}, 300000).unref?.();

// ===================================================================
//  RESPONSE CACHE  (non-streaming only, LRU-ish)
// ===================================================================

const responseCache = new Map();

function cacheKey(body) {
  if (body.stream) return null;
  // Only cache chat completions with identical model + messages + sampling params
  const key = JSON.stringify({
    m: body.model,
    msg: body.messages,
    t: body.temperature,
    top: body.top_p,
    max: body.max_tokens,
    tools: body.tools,
  });
  return crypto.createHash('sha256').update(key).digest('hex');
}

function cacheGet(key) {
  if (!key) return null;
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { responseCache.delete(key); return null; }
  // Move to end (LRU)
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.data;
}

function cacheSet(key, data) {
  if (!key) return;
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    // Delete oldest
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { ts: Date.now(), data });
}

// ===================================================================
//  MODEL CATALOG
// ===================================================================

function contextLengthFor(modelId) {
  return MODEL_CONTEXT[String(modelId || '').split('/')[0]];
}

function shortModelId(id) {
  const m = /^gpt:\/\/[^/]+\/(.+)$/.exec(String(id || ''));
  return m ? m[1] : String(id || '');
}

function modelEntry(id, ownedBy, created) {
  const entry = { id, object: 'model', created: created || 0, owned_by: ownedBy || 'yandex', permission: [], root: id, parent: null };
  const ctx = contextLengthFor(id);
  if (ctx) entry.context_length = ctx;
  return entry;
}

let catalogCache = { at: 0, data: null };

async function fetchCatalog() {
  const now = Date.now();
  if (catalogCache.data && now - catalogCache.at < MODEL_CACHE_TTL_SEC * 1000) return catalogCache.data;
  try {
    const upstream = await fetch(`${YC_BASE}/models`, {
      headers: { Authorization: await authHeader(), 'OpenAI-Project': FOLDER_ID },
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const payload = await upstream.json();
    const rows = (payload.data || []).filter(m => m && m.id && !String(m.id).includes('speech-realtime'));
    if (!rows.length) throw new Error('empty catalog');
    const data = rows.map(m => {
      const rawId = String(m.id);
      return modelEntry(/^gpt:\/\//.test(rawId) ? shortModelId(rawId) : rawId, m.owned_by, m.created);
    });
    catalogCache = { at: now, data };
    console.log(`[proxy] catalog refreshed: ${data.length} models`);
    return data;
  } catch (err) {
    console.error('[proxy] catalog fetch failed, fallback:', err.message);
    const data = MODELS.map(id => modelEntry(id, 'yandex', 0));
    catalogCache = { at: now, data };
    return data;
  }
}

// ===================================================================
//  REQUEST OPTIMIZATION HELPERS
// ===================================================================

/**
 * Rough token estimation: ~3 chars per token (mixed RU/EN).
 * This is intentionally conservative (overestimates) so we don't let
 * truly huge requests through.
 */
function estimateTokens(body) {
  let chars = 0;
  if (body.messages) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') chars += msg.content.length;
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part.text === 'string') chars += part.text.length;
        }
      }
    }
  }
  if (body.tools) chars += JSON.stringify(body.tools).length;
  if (body.tool_choice && typeof body.tool_choice === 'object') chars += JSON.stringify(body.tool_choice).length;
  return Math.ceil(chars / 3);
}

/**
 * Trim message history to MAX_HISTORY_MESSAGES.
 * Always keep the first system message (if any) and the last N user/assistant turns.
 */
function trimHistory(messages) {
  if (!Array.isArray(messages) || messages.length <= MAX_HISTORY_MESSAGES) return messages;

  const system = [];
  const rest = [];
  for (const msg of messages) {
    if (msg.role === 'system' && system.length === 0) system.push(msg);
    else rest.push(msg);
  }

  const keep = Math.max(1, MAX_HISTORY_MESSAGES - system.length);
  const trimmed = rest.slice(-keep);

  if (ACCESS_LOG) {
    console.log(`[proxy] trimmed history: ${messages.length} → ${system.length + trimmed.length} messages (kept last ${keep})`);
  }
  return [...system, ...trimmed];
}

/**
 * Estimate tool schema size in tokens.
 */
function estimateToolTokens(tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  return Math.ceil(JSON.stringify(tools).length / 3);
}

// ===================================================================
//  EXPRESS APP
// ===================================================================

const app = express();
app.use(express.json({ limit: `${MAX_BODY_BYTES}` }));

// --- Rate limiting middleware ---
app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    tokenStats.requestsRejected += 1;
    return res.status(429).json({ error: { message: `Rate limit exceeded (${RATE_LIMIT_RPM} req/min)`, type: 'rate_limit_error' } });
  }
  next();
});

// --- Stats ---
const stats = { startedAt: Date.now(), requests: 0, errors: 0, lastModel: '' };

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  version: '2.1',
  uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
  requests: stats.requests,
  errors: stats.errors,
  last_model: stats.lastModel,
  tokens: {
    total_prompt_tokens: tokenStats.totalPromptTokens,
    total_completion_tokens: tokenStats.totalCompletionTokens,
    total_tokens: tokenStats.totalTokens,
    requests_with_usage: tokenStats.requestsWithUsage,
    stream_requests: tokenStats.streamRequests,
    cache_hits: tokenStats.cacheHits,
    requests_rejected: tokenStats.requestsRejected,
  },
  cache_size: responseCache.size,
}));

// --- Token metrics endpoint ---
app.get('/metrics/tokens', (_req, res) => res.json({
  total_prompt_tokens: tokenStats.totalPromptTokens,
  total_completion_tokens: tokenStats.totalCompletionTokens,
  total_tokens: tokenStats.totalTokens,
  requests_with_usage: tokenStats.requestsWithUsage,
  stream_requests: tokenStats.streamRequests,
  cache_hits: tokenStats.cacheHits,
  requests_rejected: tokenStats.requestsRejected,
  cache_size: responseCache.size,
  by_model: tokenStats.byModel,
}));

// --- Model catalog ---
app.get('/v1/models', async (_req, res) => {
  const data = await fetchCatalog();
  res.json({ object: 'list', data: data.map(m => ({ ...m, created: m.created || Math.floor(Date.now() / 1000) })) });
});

app.get('/v1/models/:id', async (req, res) => {
  const wanted = decodeURIComponent(req.params.id);
  const data = await fetchCatalog();
  const found = data.find(m => m.id === wanted);
  if (!found) return res.status(404).json({ error: { message: `model ${wanted} not found`, type: 'invalid_request_error' } });
  res.json({ ...found, created: found.created || Math.floor(Date.now() / 1000) });
});

// --- Model URI resolver ---
function resolveModelUri(model, path) {
  const value = String(model || '');
  if (/^(gpt|emb|art):\/\//.test(value)) return value;
  if (String(path || '').startsWith('/embedding')) return `emb://${FOLDER_ID}/${value}`;
  return `gpt://${FOLDER_ID}/${value}`;
}

// --- Upstream fetch with timeout + retry ---
function upstreamCause(err) {
  const c = err?.cause;
  if (!c) return '';
  return String(c.code || c.message || c).slice(0, 160);
}

async function fetchUpstream(path, init, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(YC_BASE + path, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return upstream;
  } catch (err) {
    clearTimeout(timer);
    const cause = upstreamCause(err);
    if (attempt < UPSTREAM_RETRIES) {
      console.log(`[proxy] upstream failed: ${err.message}${cause ? ' / ' + cause : ''} — retry ${attempt + 1}/${UPSTREAM_RETRIES}`);
      await new Promise(r => setTimeout(r, 500));
      return fetchUpstream(path, init, attempt + 1);
    }
    throw new Error(`${err.message}${cause ? ` (${cause})` : ''}`);
  }
}

// --- Main proxy handler ---
async function proxyToYandex(path, req, res) {
  const started = Date.now();
  stats.requests += 1;

  try {
    const body = { ...req.body };
    if (body.model) body.model = resolveModelUri(body.model, path);
    stats.lastModel = body.model || '';

    // --- OPTIMIZATION: trim history ---
    if (body.messages) body.messages = trimHistory(body.messages);

    // --- Estimate tokens ---
    const estimatedTok = estimateTokens(body);
    const toolTok = estimateToolTokens(body.tools);

    // --- Check size limit ---
    if (estimatedTok > MAX_REQUEST_TOKENS) {
      tokenStats.requestsRejected += 1;
      console.warn(`[proxy] request rejected: ~${estimatedTok} tokens > limit ${MAX_REQUEST_TOKENS}`);
      return res.status(413).json({
        error: {
          message: `Request too large (~${estimatedTok} estimated tokens, limit ${MAX_REQUEST_TOKENS}). Reduce history or context.`,
          type: 'request_too_large',
          estimated_tokens: estimatedTok,
          limit: MAX_REQUEST_TOKENS,
        },
      });
    }

    // --- Warn about large tool schemas ---
    if (toolTok > 5000 && ACCESS_LOG) {
      console.warn(`[proxy] large tool schema: ~${toolTok} tokens (${(body.tools || []).length} tools). Consider reducing to essential tools.`);
    }

    // --- Check cache ---
    const ck = cacheKey(body);
    const cached = cacheGet(ck);
    if (cached) {
      tokenStats.cacheHits += 1;
      if (ACCESS_LOG) console.log(`[proxy] CACHE HIT model=${body.model} (~${estimatedTok}tok)`);
      return res.json(cached);
    }

    // --- Upstream request ---
    const upstream = await fetchUpstream(path, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: await authHeader(),
        'OpenAI-Project': FOLDER_ID,
        Accept: body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (ACCESS_LOG) {
      console.log(
        `[proxy] ${req.method} ${path} model=${body.model} ~${estimatedTok}tok tools=${toolTok}tok${body.stream ? ' stream' : ''} → ${upstream.status} (${Date.now() - started}ms)`
      );
    }

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', contentType);

    if (upstream.body && body.stream) {
      // Streaming: pass chunks through untouched (no buffering, no delay), but
      // tap the SSE text so the final `usage` chunk is recorded (v2.1).
      tokenStats.streamRequests += 1;
      const { Readable, Transform } = require('stream');
      const STREAM_TAP_LIMIT = 64 * 1024; // keep at most the last ~64 KB of SSE text
      let tapBuffer = '';
      let usageFinalized = false;

      const finalizeStreamUsage = () => {
        if (usageFinalized) return;
        usageFinalized = true;
        const usage = extractUsageFromSse(tapBuffer);
        if (usage) recordUsage(body.model, usage);
        else if (ACCESS_LOG) console.log(`[proxy] stream had no usage chunk model=${body.model}`);
      };

      const tap = new Transform({
        transform(chunk, _enc, cb) {
          tapBuffer += chunk.toString('utf8');
          if (tapBuffer.length > STREAM_TAP_LIMIT) tapBuffer = tapBuffer.slice(-STREAM_TAP_LIMIT);
          cb(null, chunk); // unchanged chunk — passthrough stays streaming
        },
        flush(cb) { finalizeStreamUsage(); cb(); },
      });

      const source = Readable.fromWeb(upstream.body);
      const onStreamError = (where, err) => {
        stats.errors += 1;
        console.error(`[proxy] ${where} stream error:`, err && err.message);
        finalizeStreamUsage();
        if (!res.writableEnded) res.end();
      };
      source.on('error', err => onStreamError('upstream', err));
      tap.on('error', err => onStreamError('tap', err));
      // Client aborted mid-stream: record what we saw and drop the upstream.
      res.on('close', () => {
        if (!res.writableEnded) {
          finalizeStreamUsage();
          source.destroy();
        }
      });
      source.pipe(tap).pipe(res);
    } else if (upstream.body) {
      // Non-streaming: read full response for cache + token tracking
      const text = await upstream.text();
      try {
        const json = JSON.parse(text);
        if (json.usage) recordUsage(body.model, json.usage);
        if (ck && upstream.ok) cacheSet(ck, json);
      } catch { /* not JSON — pass through */ }
      res.send(text);
    } else {
      res.end();
    }
  } catch (err) {
    stats.errors += 1;
    console.error('[proxy] error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: err.message, type: 'proxy_error' } });
    } else {
      res.end();
    }
  }
}

app.post('/v1/chat/completions', (req, res) => proxyToYandex('/chat/completions', req, res));
app.post('/v1/completions',       (req, res) => proxyToYandex('/completions', req, res));
app.post('/v1/embeddings',        (req, res) => proxyToYandex('/embeddings', req, res));

app.use((_req, res) => res.status(404).json({ error: { message: 'not found' } }));

// ===================================================================
//  SERVER START + GRACEFUL SHUTDOWN
// ===================================================================

let isShuttingDown = false;
const activeConnections = new Set();

const server = app.listen(PORT, HOST, async () => {
  console.log(`[proxy] v2.1 listening on http://${HOST}:${PORT}/v1`);
  console.log(`[proxy] limits: max_tokens=${MAX_REQUEST_TOKENS} rate=${RATE_LIMIT_RPM}rpm cache=${CACHE_MAX_ENTRIES} history=${MAX_HISTORY_MESSAGES}`);

  if (API_KEY) {
    console.log('[proxy] auth: static API key');
  } else if (IAM_TOKEN) {
    console.log('[proxy] auth: static IAM_TOKEN');
  } else {
    try { await refreshIamToken(); } catch (err) { console.error('[proxy] initial IAM refresh failed:', err.message); }
    setInterval(() => { refreshIamToken().catch(e => console.error('[proxy] refresh failed:', e.message)); }, REFRESH_MIN * 60 * 1000);
  }
  fetchCatalog().catch(e => console.error('[proxy] initial catalog fetch failed:', e.message));
});

server.on('connection', conn => {
  activeConnections.add(conn);
  conn.on('close', () => activeConnections.delete(conn));
});

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[proxy] ${signal} received — draining ${activeConnections.size} connections...`);
  server.close(() => {
    console.log('[proxy] all connections closed. Bye.');
    process.exit(0);
  });
  // Force-exit after 15s
  setTimeout(() => {
    console.error('[proxy] forced shutdown (timeout)');
    process.exit(1);
  }, 15000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
