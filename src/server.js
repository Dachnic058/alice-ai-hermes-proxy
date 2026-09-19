/**
 * alice-ai-hermes-proxy
 * OpenAI-compatible proxy for Alice AI / YandexGPT (Yandex Cloud AI Studio).
 *
 * Auth modes (pick ONE): API_KEY (static key, simplest) | IAM_TOKEN | SA_JSON / SA_JSON_PATH
 *   1) API_KEY               — static AI Studio API key (header: Api-Key), simplest
 *   2) IAM_TOKEN             — ready IAM token (lifetime ~12 h for user tokens, ~1 h for SA tokens)
 *   3) SA_JSON / SA_JSON_PATH — service account authorized key; proxy exchanges it for an IAM token
 *                               and auto-refreshes every TOKEN_REFRESH_INTERVAL_MIN minutes.
 *
 * Endpoints exposed: /healthz, /v1/models, /v1/models/:id, /v1/chat/completions,
 *                    /v1/completions, /v1/embeddings
 *
 * Model addressing: a client may send either the short id from GET /v1/models
 * ("aliceai-llm/latest") or a fully qualified URI ("gpt://<folder>/aliceai-llm/latest").
 * Short ids are prefixed for the upstream, qualified URIs pass through untouched.
 *
 * GET /v1/models is served from the LIVE upstream catalog (cached for
 * MODEL_CACHE_TTL_SEC seconds, falling back to PROXY_MODELS when upstream is
 * unreachable) and each chat model carries its documented `context_length`, which is what
 * Hermes uses to size the context window for the model.
 *
 * Never expose this proxy to the public internet without an auth layer.
 */

require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';

const YC_BASE =
  process.env.YC_BASE_URL ||
  'https://ai.api.cloud.yandex.net/v1';

const FOLDER_ID = process.env.FOLDER_ID || process.env.YC_FOLDER_ID || '';
if (!FOLDER_ID) {
  console.error('[proxy] FOLDER_ID is not set. Requests will fail.');
}

// Fallback model list, used only when the live upstream catalog cannot be reached
// (comma separated ids, e.g. "yandexgpt/latest,aliceai-llm/latest").
const MODELS = (process.env.PROXY_MODELS ||
  'aliceai-llm/latest,aliceai-llm-flash/latest,yandexgpt-5-pro/latest,yandexgpt-5.1/latest,yandexgpt-5-lite/latest,yandexgpt/latest,yandexgpt-lite/latest,deepseek-v4-flash/latest,qwen3-235b-a22b-fp8/latest,qwen3.6-35b-a3b/latest,gpt-oss-120b/latest,gpt-oss-20b/latest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Context windows, taken from the Yandex AI Studio "Common instance models" table
// (https://yandex.cloud/en/docs/ai-studio/concepts/generation/models). Keyed by the base
// model name; a missing entry simply means "unknown" and the field is omitted.
const MODEL_CONTEXT = {
  'aliceai-llm': 131072,
  'aliceai-llm-flash': 65536,
  'yandexgpt-5.1': 32768,
  'yandexgpt-5-pro': 32768,
  'yandexgpt-5-lite': 32768,
  'yandexgpt': 32768, // yandexgpt/latest and /rc are served by YandexGPT Pro 5 / 5.1 (32k)
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

const MODEL_CACHE_TTL_SEC = parseInt(process.env.MODEL_CACHE_TTL_SEC || '300', 10);

// --------------------------- IAM token manager ---------------------------

const API_KEY = process.env.API_KEY || process.env.YC_API_KEY || '';
const IAM_TOKEN = process.env.IAM_TOKEN || '';
const SA_JSON = process.env.SA_JSON || '';
const SA_JSON_PATH = process.env.SA_JSON_PATH || '';
const REFRESH_MIN = parseInt(process.env.TOKEN_REFRESH_INTERVAL_MIN || '55', 10);

let cachedIamToken = '';
let lastRefreshAt = 0;

function loadServiceAccountKey() {
  if (SA_JSON) return JSON.parse(SA_JSON);
  if (SA_JSON_PATH) return JSON.parse(require('fs').readFileSync(SA_JSON_PATH, 'utf8'));
  return null;
}

function createServiceAccountJwt(saKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'https://iam.api.cloud.yandex.net/iam/v1/tokens:exchange',
    iss: saKey.service_account_id,
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: 'PS256', typ: 'JWT', kid: saKey.id };
  return jwt.sign(payload, saKey.private_key, { algorithm: 'PS256', header });
}

async function exchangeJwtForIamToken(jwtToken) {
  const res = await fetch('https://iam.api.cloud.yandex.net/iam/v1/tokens:exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jwt: jwtToken }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IAM exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.iamToken;
}

async function refreshIamToken() {
  const saKey = loadServiceAccountKey();
  if (!saKey) return; // static token mode
  const iam = await exchangeJwtForIamToken(createServiceAccountJwt(saKey));
  cachedIamToken = iam;
  lastRefreshAt = Date.now();
  console.log('[proxy] IAM token refreshed at', new Date().toISOString());
}

async function getIamToken() {
  if (IAM_TOKEN) return IAM_TOKEN; // static mode, no refresh
  const due = Date.now() - lastRefreshAt > REFRESH_MIN * 60 * 1000;
  if (!cachedIamToken || due) await refreshIamToken();
  return cachedIamToken;
}

async function authHeader() {
  return API_KEY ? `Api-Key ${API_KEY}` : `Bearer ${await getIamToken()}`;
}

// --------------------------- model catalog ---------------------------

function contextLengthFor(modelId) {
  const base = String(modelId || '').split('/')[0];
  return MODEL_CONTEXT[base];
}

function shortModelId(id) {
  const m = /^gpt:\/\/[^/]+\/(.+)$/.exec(String(id || ''));
  return m ? m[1] : String(id || '');
}

function modelEntry(id, ownedBy, created) {
  const entry = {
    id,
    object: 'model',
    created: created || 0,
    owned_by: ownedBy || 'yandex',
    permission: [],
    root: id,
    parent: null,
  };
  const ctx = contextLengthFor(id);
  if (ctx) entry.context_length = ctx;
  return entry;
}

let catalogCache = { at: 0, data: null };

async function fetchCatalog() {
  const now = Date.now();
  if (catalogCache.data && now - catalogCache.at < MODEL_CACHE_TTL_SEC * 1000) {
    return catalogCache.data;
  }
  try {
    const upstream = await fetch(`${YC_BASE}/models`, {
      headers: { Authorization: await authHeader(), 'OpenAI-Project': FOLDER_ID },
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const payload = await upstream.json();
    const rows = (payload.data || []).filter(
      (m) => m && m.id && !String(m.id).includes('speech-realtime') // Realtime API only — not callable via /v1/chat/completions
    );
    if (!rows.length) throw new Error('empty catalog');
    const data = rows.map((m) => {
      const rawId = String(m.id);
      // Chat models: expose the short id (what a client can pass straight back).
      // Embedding / other non-gpt URIs: keep the qualified form — the proxy passes
      // those through untouched.
      const id = /^gpt:\/\//.test(rawId) ? shortModelId(rawId) : rawId;
      return modelEntry(id, m.owned_by, m.created);
    });
    catalogCache = { at: now, data };
    console.log(`[proxy] catalog refreshed from upstream: ${data.length} models`);
    return data;
  } catch (err) {
    console.error('[proxy] catalog fetch failed, using PROXY_MODELS fallback:', err.message);
    const data = MODELS.map((id) => modelEntry(id, 'yandex', 0));
    catalogCache = { at: now, data };
    return data;
  }
}

// --------------------------- express app ---------------------------

const app = express();
app.use(express.json({ limit: '32mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/v1/models', async (req, res) => {
  const data = await fetchCatalog();
  res.json({
    object: 'list',
    data: data.map((m) => ({ ...m, created: m.created || Math.floor(Date.now() / 1000) })),
  });
});

app.get('/v1/models/:id', async (req, res) => {
  const wanted = decodeURIComponent(req.params.id);
  const data = await fetchCatalog();
  const found = data.find((m) => m.id === wanted);
  if (!found) {
    return res.status(404).json({ error: { message: `model ${wanted} not found`, type: 'invalid_request_error' } });
  }
  res.json({ ...found, created: found.created || Math.floor(Date.now() / 1000) });
});

// A short id ("aliceai-llm/latest") becomes a full AI Studio URI; anything already
// carrying a scheme is passed through unchanged.
function resolveModelUri(model, path) {
  const value = String(model || '');
  if (/^(gpt|emb|art):\/\//.test(value)) return value;
  if (String(path || '').startsWith('/embedding')) return `emb://${FOLDER_ID}/${value}`;
  return `gpt://${FOLDER_ID}/${value}`;
}

async function proxyToYandex(path, req, res) {
  try {
    const body = { ...req.body };
    if (body.model) body.model = resolveModelUri(body.model, path);
    const upstream = await fetch(YC_BASE + path, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: await authHeader(),
        'OpenAI-Project': FOLDER_ID,
        Accept: req.body && req.body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', contentType);

    if (upstream.body) {
      const { Readable } = require('stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error('[proxy] error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: err.message, type: 'proxy_error' } });
    } else {
      res.end();
    }
  }
}

app.post('/v1/chat/completions', (req, res) => proxyToYandex('/chat/completions', req, res));
app.post('/v1/completions', (req, res) => proxyToYandex('/completions', req, res));
app.post('/v1/embeddings', (req, res) => proxyToYandex('/embeddings', req, res));

app.use((req, res) => res.status(404).json({ error: { message: 'not found' } }));

app.listen(PORT, HOST, async () => {
  console.log(`[proxy] listening on http://${HOST}:${PORT}/v1`);
  console.log(`[proxy] fallback models: ${MODELS.join(', ')}`);
  if (API_KEY) {
    console.log('[proxy] using static API key (Api-Key auth)');
  } else if (IAM_TOKEN) {
    console.log('[proxy] using static IAM_TOKEN from env');
  } else {
    try {
      await refreshIamToken();
    } catch (err) {
      console.error('[proxy] initial IAM refresh failed:', err.message);
    }
    setInterval(() => {
      refreshIamToken().catch((e) => console.error('[proxy] refresh failed:', e.message));
    }, REFRESH_MIN * 60 * 1000);
  }
  fetchCatalog().catch((e) => console.error('[proxy] initial catalog fetch failed:', e.message));
});
