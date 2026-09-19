# alice-ai-hermes-proxy

OpenAI-совместимый прокси для моделей **Alice AI / YandexGPT** из Yandex Cloud, чтобы подключить их в **Hermes** (Desktop или CLI) как обычный Custom Endpoint.

У YandexGPT нет «привычного» OpenAI API-ключа — вместо него используются:
- **IAM-токен** (короткоживущий) или **ключ сервисного аккаунта** (`authorized_key.json`),
- **Folder ID**.

Этот прокси сам обменивает ключ сервисного аккаунта на IAM-токен и **автоматически его обновляет**, а снаружи выглядит как обычный OpenAI-совместимый эндпоинт `/v1`.

---

## Что поддерживается

| OpenAI-метод          | Куда мапится в Yandex Cloud                          |
|-----------------------|------------------------------------------------------|
| `POST /v1/chat/completions` | `foundationModels/v1/chat/completions`         |
| `POST /v1/completions`      | `foundationModels/v1/completion`               |
| `POST /v1/embeddings`       | `foundationModels/v1/textEmbedding`            |
| `GET  /v1/models`           | Список моделей из `PROXY_MODELS`               |
| `GET  /healthz`             | Проверка, что прокси живой                     |

- **Стриминг** (`"stream": true`) проксируется напрямую (SSE).
- **Автообновление IAM-токена** по расписанию (по умолчанию раз в 55 минут).
- Модели для Alice AI задайте в `PROXY_MODELS` (например `alice-ai/latest`) — прокси прозрачно форвардит `model` в запросе.

## Быстрый старт

### 1. Склонируй и установи зависимости

```bash
git clone https://github.com/Dachnic058/alice-ai-hermes-proxy.git
cd alice-ai-hermes-proxy
npm install
```

### 2. Настрой `.env`

```bash
cp .env.example .env
```

Самый простой вариант — статический API-ключ:

```env
FOLDER_ID=b1g.........
API_KEY=AQVN.........
PROXY_MODELS=yandexgpt/latest,yandexgpt-lite/latest,alice-ai/latest
```

> `API_KEY` — это статический API-ключ сервисного аккаунта (начинается с `AQVN...`), а не IAM-токен. Он не истекает сам.

Альтернатива для продакшена с автообновлением — ключ сервисного аккаунта:

```env
FOLDER_ID=b1g.........
SA_JSON_PATH=./authorized_key.json
PROXY_MODELS=yandexgpt/latest,yandexgpt-lite/latest,alice-ai/latest
```

Ключ сервисного аккаунта получают так: Yandex Cloud → IAM → Service Accounts → выбрать SA → **Create new key** → скачать `authorized_key.json` и положить рядом с `.env`.

### 3. Запусти

```bash
npm start
# прокси на http://127.0.0.1:3000/v1
```

### 4. Проверь

```bash
curl http://127.0.0.1:3000/v1/models

curl http://127.0.0.1:3000/v1/chat/completions   -H "Content-Type: application/json"   -d '{
    "model": "yandexgpt/latest",
    "messages": [{"role": "user", "content": "Привет!"}]
  }'
```

## Подключение к Hermes

### Hermes Desktop (GUI)

1. **Settings → Providers → Add Provider → Custom Endpoint**
2. Base URL: `http://127.0.0.1:3000/v1`
3. API Key: любое значение, например `dummy` (прокси его игнорирует)
4. Name: `Alice AI via Proxy`
5. Сохрани → модель появится в списке.

### Hermes CLI

```bash
hermes model add --name "Alice AI via Proxy"   --provider custom   --base-url http://127.0.0.1:3000/v1   --api-key dummy
```

## Деплой

### PM2 (рекомендуется для VPS, например Hetzner)

```bash
npm install
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # автозапуск после перезагрузки
```

> В PM2 < 5.4 `.env` автоматически не подхватывается — запускайте так:
> `pm2 start src/server.js --name alice-ai-hermes-proxy --node-args="--env-file=.env"`

### Docker

```bash
cp .env.example .env   # заполните
docker compose up -d --build
```

## Важные замечания

- **Никогда не выкладывайте** `authorized_key.json` и `.env` в git (они в `.gitignore`).
- **API-ключ начинающийся с `AQVN...`** — статический API-ключ сервисного аккаунта: подходит для `API_KEY`, не истекает сам. IAM-токен (`t1....`) — временный, для `IAM_TOKEN`. Для автообновления — `authorized_key.json`.
- Токены валятся в биллинг **Yandex Cloud** — лимиты/квоты смотрите там.
- Если Hermes на другом хосте — запустите прокси на VPS и укажите в Hermes `http://<vps-ip>:3000/v1`, при этом **ограничьте доступ** (фаервол / VPN / reverse proxy с авторизацией), так как эндпоинт без авторизации тратит ваши токены.

## Архитектура

```
Hermes (Custom Endpoint)
   │  OpenAI-формат
   ▼
alice-ai-hermes-proxy (Express, :3000)
   │  Authorization: Bearer <IAM> + x-folder-id
   ▼
Yandex Cloud foundationModels/v1
```

## Лицензия

MIT
