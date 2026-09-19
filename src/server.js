/**
 * alice-ai-hermes-proxy
 * OpenAI-compatible proxy for Alice AI / YandexGPT (Yandex Cloud).
 *
 * Auth modes (pick ONE):
 *   1) IAM_TOKEN            — ready IAM token (lifetime ~12 h for user tokens, ~1 h for service account tokens)
 *   2) SA_JSON / SA_JSON_PATH — service account authorized key; proxy exchanges it for an IAM token
 *                               and auto-refreshes it every TOKEN_REFRESH_INTERVAL_MIN minutes.
 *
 * Never expose this proxy to the public internet without an auth layer.
 */

const express = require('express');
const jwt = require('jsonwebtoken');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';

const YC_BASE =
  process.env.YC_BASE_URL ||
  'https://llm.api.cloud.yandex.net/foundationModels/v1';

const FOLDER_ID = process.env.FOLDER_ID || '';
if (!FOLDER_ID) {
  console.error('[proxy] FOLDER_ID is not set. Requests will fail.');
}

// Models returned by GET /v1/models (comma separated ids, e.g. "yandexgpt/latest,alice-ai/latest")
const MODELS = (process.env.PROXY_MODELS ||
  'yandexgpt/latest,yandexgpt-lite/latest,yandexgpt-rc/latest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// --------------------------- IAM token manager ---------------------------

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

// --------------------------- express app ---------------------------

const app = express();
app.use(express.json({ limit: '32mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: MODELS.map((id, i) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'yandex',
      permission: [],
      root: id,
      parent: null,
    })),
  });
});

async function proxyToYandex(path, req, res) {
  try {
    const iam = await getIamToken();
    const upstream = await fetch(YC_BASE + path, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${iam}`,
        'x-folder-id': FOLDER_ID,
        Accept: req.body && req.body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(req.body),
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
app.post('/v1/completions', (req, res) => proxyToYandex('/completion', req, res));
app.post('/v1/embeddings', (req, res) => proxyToYandex('/textEmbedding', req, res));

app.use((req, res) => res.status(404).json({ error: { message: 'not found' } }));

app.listen(PORT, HOST, async () => {
  console.log(`[proxy] listening on http://${HOST}:${PORT}/v1`);
  console.log(`[proxy] models: ${MODELS.join(', ')}`);
  if (!IAM_TOKEN) {
    try {
      await refreshIamToken();
    } catch (err) {
      console.error('[proxy] initial IAM refresh failed:', err.message);
    }
    setInterval(() => {
      refreshIamToken().catch((e) => console.error('[proxy] refresh failed:', e.message));
    }, REFRESH_MIN * 60 * 1000);
  } else {
    console.log('[proxy] using static IAM_TOKEN from env');
  }
});
