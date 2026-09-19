# alice-ai-hermes-proxy

OpenAI-совместимый прокси к **Yandex Cloud AI Studio** (Alice AI LLM, YandexGPT 5, DeepSeek, Qwen, gpt-oss) — чтобы эти модели можно было использовать в **Hermes Agent**.
Слушает только localhost, наружу ничего не отдаёт.

## Что умеет

| Endpoint | Назначение |
|---|---|
| `GET /healthz` | проверка живости |
| `GET /v1/models` | **живой** каталог моделей папки Yandex + окно контекста у каждой модели |
| `GET /v1/models/:id` | одна модель (можно узнать её `context_length`) |
| `POST /v1/chat/completions` | чат (в т.ч. `stream: true` и `tools` — function calling) |
| `POST /v1/completions` | legacy completions |
| `POST /v1/embeddings` | эмбеддинги (`text-embeddings-v2-doc/latest` и др.) |

Основные возможности:

- Каталог моделей берётся **из Yandex** (`GET /v1/models`, кэш 5 минут) — в Hermes видно ровно те модели, к которым есть доступ, с их реальным окном контекста.
- Имя модели можно передавать коротко (`aliceai-llm/latest`) или полным URI (`gpt://<folder>/aliceai-llm/latest`) — оба варианта работают.
- Три режима авторизации: статический `API_KEY` (проще всего), готовый `IAM_TOKEN`, ключ сервисного аккаунта `SA_JSON` с автообновлением токена каждые ~55 минут.

## Модели (проверено на живом ключе)

Окно контекста — из документации Yandex AI Studio (Common instance models). Hermes требует минимум **64 000** токенов для работы с инструментами, поэтому «главной» моделью можно ставить только строки с ✔.

| Модель (короткое id) | Контекст | Можно как основную в Hermes |
|---|---|---|
| `aliceai-llm/latest` — Alice AI LLM | 131 072 | ✔ |
| `aliceai-llm-flash/latest` — Alice AI LLM Flash | 65 536 | ✔ |
| `deepseek-v4-flash/latest` | 1 048 576 | ✔ |
| `qwen3.6-35b-a3b/latest` | 262 144 | ✔ |
| `qwen3-235b-a22b-fp8/latest` | 262 144 | ✔ |
| `gpt-oss-120b/latest` | 131 072 | ✔ |
| `gpt-oss-20b/latest` | 131 072 | ✔ |
| `yandexgpt-5-pro/latest` — YandexGPT Pro 5 | 32 768 | — (мало для Hermes) |
| `yandexgpt-5.1/latest` — YandexGPT Pro 5.1 | 32 768 | — |
| `yandexgpt-5-lite/latest` — YandexGPT Lite 5 | 32 768 | — |
| `yandexgpt/latest`, `yandexgpt/rc`, `yandexgpt-lite/*` | 32 768 | — |

Проверено 19.09.2026: обычный ответ, стриминг и **function calling** работают у всех моделей выше (кроме `speech-realtime-*` — это Realtime API, через `/v1/chat/completions` они недоступны, поэтому прокси их из каталога исключает).

### Модели и вызов инструментов в Hermes (измерено, не предположение)

Hermes — агент: если модель не умеет вызов инструментов, она бесполезна как основная. Проверено реальным запуском Hermes через прокси:

| Модель | Полный набор инструментов Hermes (~20) | Урезанный (`-t terminal,file,web`) |
|---|---|---|
| `aliceai-llm/latest` | ✗ отвечает **текстом** в виде ```terminal {"command": ...}``` — вызова инструмента нет | ✔ 2 реальных tool_call |
| `aliceai-llm-flash/latest` | ✔ 2 tool_call | ✔ |
| `qwen3.6-35b-a3b/latest` | ✔ 4 tool_call | ✔ |
| `gpt-oss-120b/latest` | ✔ 2 tool_call | ✔ |
| `deepseek-v4-flash/latest` | ✔ 2 tool_call | ✔ |

Сам API-вызов с параметром `tools` работает у Alice AI LLM всегда (в том числе с 30 инструментами с простыми схемами) — ломается именно связка «большой системный промпт + сложные схемы реальных инструментов Hermes». Итог:

- хочешь **Алису** — запускай с урезанным набором: `hermes chat -q "..." -m alice -t terminal,file,web`;
- нужен полный арсенал инструментов — бери `alice-flash`, `qwen-ya`, `oss-ya` или `ds-ya`.

## Установка на сервер (где работает Hermes)

```bash
cd /root/.hermes/health-assistant/alice-ai-hermes-proxy
# ключи: FOLDER_ID=b1... и API_KEY=AQVN...
bash deploy/install-host.sh
```

Скрипт: проверит каталог и `.env`, поставит Node.js если его нет, доставит npm-зависимости, пропишет systemd-сервис `alice-ai-proxy` (автозапуск после перезагрузки + авторестарт), дождётся `/healthz`, покажет каталог моделей и сделает **реальный запрос** к модели. Если systemd недоступен — поднимет через `nohup` и добавит `@reboot` в crontab. Скрипт идемпотентный.

Ручной запуск (без автозапуска):

```bash
cd /root/.hermes/health-assistant/alice-ai-hermes-proxy
node src/server.js            # .env подхватывается автоматически (dotenv)
curl -s http://127.0.0.1:3000/v1/models | head -c 300
```

## Подключение к Hermes

```bash
bash /root/.hermes/health-assistant/alice-ai-hermes-proxy/deploy/connect-hermes.sh
```

Скрипт регистрирует endpoint в Hermes и заводит короткие алиасы моделей — после этого в `hermes model` появляется строка с живым списком моделей Yandex, а переключение работает командами вида `/model alice`.

Что именно прописывается в `~/.hermes/config.yaml` (эквивалент вручную):

```
hermes config set custom_providers '[{"name":"alice","base_url":"http://127.0.0.1:3000/v1","api_key":"dummy","model":"aliceai-llm/latest"}]'

hermes config set model_aliases.alice.model        aliceai-llm/latest
hermes config set model_aliases.alice.provider     custom
hermes config set model_aliases.alice.base_url     http://127.0.0.1:3000/v1
```

Сделать Alice AI LLM моделью по умолчанию (необязательно):

```
hermes config set model.provider       custom
hermes config set model.base_url       http://127.0.0.1:3000/v1
hermes config set model.default        aliceai-llm/latest
hermes config set model.context_length 131072
```

> Порядок важен: сначала `model.provider`, потом `model.base_url` — иначе Hermes считает `base_url` «наследством» прежнего провайдера и очищает его.

## Диагностика

```bash
systemctl status alice-ai-proxy          # или: journalctl -u alice-ai-proxy -n 50
tail -30 /root/.hermes/health-assistant/alice-ai-hermes-proxy/proxy.log
curl -s http://127.0.0.1:3000/healthz    # requests / uptime_s / last_model
curl -s http://127.0.0.1:3000/v1/models | head -c 400
python3 scripts/probe_models.py          # прогоняет каждую модель: чат + function calling
```

Частые ошибки:

- `Failed to get model` — модели с таким id нет в твоей папке. Посмотри живой список: `curl -s localhost:3000/v1/models`.
- `401 / Unknown api key` — ключ в `.env` не тот или у сервисного аккаунта нет роли `ai.languageModels.user`.
- `503` при работе Hermes — прокси не запущен (проверь `systemctl status alice-ai-proxy`).
- В логе бесконечный `Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`, сервис циклично перезапускается — порт держит СТАРЫЙ экземпляр прокси (обычно запущенный когда-то вручную через `nohup`). Он отдаёт устаревший список моделей, а новый сервис не может занять порт. Лечение:

```bash
bash /root/.hermes/health-assistant/alice-ai-hermes-proxy/deploy/kill-stale-proxy.sh
: > /root/.hermes/health-assistant/alice-ai-hermes-proxy/proxy.log   # очистить мусор
bash /root/.hermes/health-assistant/alice-ai-hermes-proxy/deploy/install-host.sh
```

`kill-stale-proxy.sh` не требует `fuser`/`lsof` (их на минимальных образах может не быть): он находит процессы по рабочему каталогу проекта через `/proc`, а владельца порта — через `/proc/net/tcp` и `python3`. Чужие node-процессы не трогает.

Начиная с этой версии `install-host.sh` сам останавливает прежние экземпляры прокси (по рабочему каталогу процесса), а `connect-hermes.sh` отказывается настраивать Hermes, если каталог моделей подозрительно короткий (признак старого процесса).

Логи запросов: каждый вызов пишется в `proxy.log` строкой вида

```
[proxy] POST /v1/chat/completions model=gpt://<folder>/aliceai-llm/latest stream -> 200 (1128ms)
```

Отключить (если нужен только шум от ошибок): `PROXY_ACCESS_LOG=0` в `.env`.

## Безопасность

- `HOST=127.0.0.1` по умолчанию: доступен только на самом сервере. Не выставляй прокси в интернет без слоя авторизации — тогда его ключ смогут тратить чужие.
- `.env` не попадает в git (см. `.gitignore`).
- Для доступа с Windows-машины используй SSH-туннель, а не публикацию порта.

## Тесты

Запустить прокси и прогнать все модели (чат + function calling) с реальным ключом:

```bash
node src/server.js &
python3 scripts/probe_models.py
```

Результат на 19.09.2026 — все 13 chat-моделей ответили, у всех работает `tool_calls`.
