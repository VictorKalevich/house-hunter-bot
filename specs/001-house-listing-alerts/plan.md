# Implementation Plan: Уведомления о новых домах с участками

**Branch**: `001-house-listing-alerts` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-house-listing-alerts/spec.md`

## Summary

Telegram-бот на одном Cloudflare Worker (бесплатный тариф) с базой D1. Раз в минуту cron запускает «тик»: тик
читает очередные страницы лент четырёх сайтов, сохраняет объявления, отбирает новые под поиски пользователей,
считает дорожные расстояния и отправляет уведомления. Каждый шаг укладывается в 10 мс CPU и 50 подзапросов. Сайты
читаются в рамках robots.txt (Конституция 1.2.0):
- kufar.by — открытый JSON API;
- realt.by — JSON из HTML страниц регионов;
- domovita.by — JSON страниц Next.js;
- moyareklama.by — разбор HTML, координаты из карточки.

Поиски настраиваются и просматриваются в мини-приложении Telegram, построенном только из дизайн-системы. Чат нужен
для главного меню, уведомлений и действий владельца: приглашения, пользователи, состояние сайтов. Расстояния:
- по прямой — гаверсинус;
- по дороге и «от выезда» — один маршрут openrouteservice, самый быстрый; «от выезда» — часть маршрута за границей
  пункта;
- справочник населённых пунктов с границами собирается из OpenStreetMap один раз скриптом.

Решения и альтернативы — [research.md](research.md), модель — [data-model.md](data-model.md), интерфейсы —
[contracts/](contracts/), проверка — [quickstart.md](quickstart.md).

### Как работает тик

```text
cron * * * * * ──▶ tick (аренда locks)
  1. deliver      — pending-уведомления → sendMessage (≤ 20; 429 → стоп; 403 → blocked)
  2. poll-feeds   — просроченные ленты: ≤ 1 запрос к сайту, сумма cost ≤ 6 → адаптер.parsePage
  3. ingest       — нормализация (валюта, сотки, место, is_new) → upsert listings (batch)
  4. match        — до 50 pending-объявлений × активные поиски → notifications (INSERT OR IGNORE, batch)
                    нет дорожного расстояния → пара в distances (pending), объявление ждёт ≤ 20 мин
  5. route        — до 10 пар: ORS directions/matrix (запас — FOSSGIS OSRM) → road_center_km, road_exit_km
cron 30 0 * * * ──▶ daily: курс НБ РБ, чистка (объявления > 30 дней, уведомления > 1 года), смена отметок номеров,
                         сверка robots.txt
POST /telegram/webhook ──▶ доступ, /start, приглашения, действия владельца
GET /app, /api/*       ──▶ мини-приложение: поиски, подсказки пунктов, список объявлений
```

## Technical Context

**Language/Version**: JavaScript (ES-модули, JSDoc), без сборки; Node.js 24 для разработки и тестов; среда
выполнения — Cloudflare Workers (`compatibility_date` — актуальная на момент реализации)

**Primary Dependencies**: нет зависимостей времени выполнения; devDependencies — `wrangler` 4.x (сборка, D1,
выкат), `miniflare` 4.x (сквозной тест). Внешние сервисы: Telegram Bot API, openrouteservice (`api.heigit.org`,
бесплатный ключ), FOSSGIS OSRM (запас), API НБ РБ; для разовой сборки справочника — Overpass API

**Storage**: Cloudflare D1 (SQLite), миграции `migrations/NNNN_*.sql`; сид справочника пунктов
`seeds/settlements.sql`

**Testing**: `node:test`: `npm test` — быстрые (дизайн-система, адаптеры на сохранённых страницах, фильтры,
расстояния, robots.txt, подпись мини-приложения, сообщения); `npm run test:e2e` — Miniflare с локальной D1 и
подменой сайтов, Telegram, ORS и НБ РБ; `npm run bench` — CPU разбора страниц

**Target Platform**: Cloudflare Workers Free + D1 + Cron Triggers; клиент — Telegram (iOS, Android, компьютер), мини-приложение
в его встроенном браузере

**Project Type**: веб-сервис (Telegram-бот: webhook, cron, JSON API) + мини-приложение Telegram без сборки

**Performance Goals**: подходящее объявление — пользователю ≤ 30 мин после появления (SC-001); круг каждой ленты —
раз в 15–25 мин (FR-003); разбор страницы ≤ её `cost` (≤ 5 мс, тяжёлая страница realt — ≤ 8 мс) в `npm run bench`;
ответ мини-приложения ≤ 1 с

**Constraints**: ≤ 10 мс CPU и ≤ 50 подзапросов (D1 входит, batch = 1) на вызов; ≤ 100 000 вызовов в сутки; D1 —
≤ 5 млн чтений и ≤ 100 тыс. записей строк в сутки, ≤ 500 МБ; к одному сайту — ≤ 1 запроса в минуту, только адреса,
открытые в robots.txt; ORS — ≤ 2 000 маршрутов и ≤ 500 матриц в сутки, ≤ 40 в минуту; FOSSGIS — ≤ 1 запроса в
секунду; секреты только в Cloudflare

**Scale/Scope**: владелец и десятки приглашённых, десятки поисков; ~1 000 новых и поднятых объявлений в сутки по
четырём сайтам, ~20–30 тыс. объявлений в базе; ~2 500 страниц выдачи в сутки; справочник ~22 750 пунктов;
3 экрана мини-приложения, 4 адаптера, 2 cron

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Конституция 1.2.0. Проверено до исследования и повторно после проектирования (data-model, contracts, quickstart).

| Принцип | Как выполняется | Итог |
|---|---|---|
| I. Бережно к сайтам (NON-NEGOTIABLE) | Только публичные страницы и `api.kufar.by` (robots.txt нет), без входа. Адреса лент — только открытые в robots.txt (`?page=N`, карточки); robots.txt сверяется раз в сутки, закрытый адрес → `disallowed`. Сортировка по дате закрыта у realt, domovita, moyareklama → первые страницы выдачи по умолчанию по регионам и разделам (1.2.0). Не больше одного запроса к сайту в тик (пауза ≥ 1 мин), круг ленты ≥ 15 мин. 403/429/капча → `blocked`, сообщение владельцу, редкие проверки; адреса, заголовки, cookie и прокси не меняются. Честный User-Agent. Хранятся только ссылка, цена, площади, координаты, место, даты, одна ссылка на фото; контакты продавцов не читаются | ✅ |
| II. Ни одного дубля, ни одного пропуска | `UNIQUE (source, external_id)`; `UNIQUE (user_id, source, external_id)` + `INSERT OR IGNORE` в batch-транзакции; аренда тика; неотправленное — повтор с паузами; зависшее после отправки — `uncertain` без повтора (R9). Сбой одного источника не трогает другие; ошибки разбора — сообщение владельцу, а не «нет новых» | ✅ |
| III. Спецификация до кода | Ветка `001-house-listing-alerts`, `specs/001-…`; решения владельца при планировании внесены в spec.md (Clarifications, Assumptions) в этой же ветке | ✅ |
| IV. Бесплатно и без своего сервера | Workers Free + D1 + Cron (2 из 5). Бюджет тика: CPU-оценка ≤ 6 мс, ≤ 45 подзапросов; тяжёлая работа — пачками по тикам. ORS — бесплатный ключ в пределах квоты, FOSSGIS — запас ≤ 300 в сутки, НБ РБ — раз в сутки; маршруты, курс и справочник кешируются в D1. Оценка по D1 — data-model.md | ✅ |
| V. Проверено до выката | Адаптеры — тесты на сохранённых страницах каждого сайта; фильтры и расстояния — юнит-тесты с границами диапазонов и неуказанными полями; сквозной тест в Miniflare: «новое объявление → фильтр → одно уведомление», повтор тика, сбой источника | ✅ |
| VI. Просто для пользователя | Русский интерфейс; мини-приложение работает в Telegram на iOS, Android и компьютере без установки; поиски — формой и кнопками; уведомление: цена, дом, участок, расстояние, место, ссылка | ✅ |
| VII. Только дизайн-система (NON-NEGOTIABLE) | Мини-приложение — только `ds-*` и токены; CSS дизайн-системы подставляется на место `/*@design-system*/`; текст — через `textContent`; `tests/design-system.test.mjs` проверяет `src/app/`. Не хватит элемента — сначала в дизайн-систему (токен → компонент → `preview.html` → README) | ✅ |
| Безопасность и данные | Webhook — только с `X-Telegram-Bot-Api-Secret-Token`; API мини-приложения — проверка подписи `initData`; секреты (`BOT_TOKEN`, `WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`, `ORS_API_KEY`) — в секретах Cloudflare, `.dev.vars` в `.gitignore`; экранирование в сообщениях; о пользователе — ID, имя, условия поиска, отметки уведомлений; об отказе — только ID и время | ✅ |
| Процесс разработки | PowerShell-скрипты Spec Kit; документация библиотек — Context7; в tasks.md — отдельная задача на README (установка, секреты, команды, атрибуция OSM/ORS); `npm test` перед коммитом, `npm run test:e2e` перед слиянием и выкатом | ✅ |

Нарушений нет — Complexity Tracking пуст.

## Project Structure

### Documentation (this feature)

```text
specs/001-house-listing-alerts/
├── spec.md              # спецификация (+ решения владельца при планировании)
├── plan.md              # этот файл
├── research.md          # Phase 0: решения по сайтам, платформе, маршрутам, справочнику
├── data-model.md        # Phase 1: таблицы D1, правила, переходы состояний
├── quickstart.md        # Phase 1: установка и проверка сценариев
├── contracts/
│   ├── telegram-bot.md  # webhook, доступ, кнопки, тексты, обработка ответов Telegram
│   ├── miniapp-api.md   # HTTP API мини-приложения и экраны
│   └── source-adapter.md# интерфейс адаптера сайта, классификация сбоев
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
wrangler.jsonc                  # Worker, D1 (DB), crons, текстовые модули
package.json                    # test, test:e2e, bench, dev, deploy
migrations/
└── 0001_init.sql               # таблицы и индексы из data-model.md
seeds/
└── settlements.sql             # справочник пунктов и границ (собран скриптом, ODbL)
scripts/
├── build-settlements.mjs       # Overpass → seeds/settlements.sql (разово, у разработчика)
├── setup-telegram.mjs          # setWebhook, setMyCommands, setChatMenuButton
└── bench.mjs                   # CPU разбора сохранённых страниц против cost
src/
├── index.js                    # fetch + scheduled
├── config.js                   # интервалы, бюджеты, лимиты
├── db/                         # запросы по таблицам: users, invites, searches, listings, feeds, sources,
│                               #   distances, notifications, settlements, rates, locks
├── sources/
│   ├── kufar.js  realt.js  domovita.js  moyareklama.js   # адаптеры (contracts/source-adapter.md)
│   ├── normalize.js            # валюта, сотки, место, geo_key, is_new
│   └── robots.js               # разбор robots.txt и проверка адресов
├── geo/
│   ├── haversine.js  polyline.js  polygon.js   # расстояния, декодер, точка в полигоне
│   ├── exit-distance.js        # «от выезда» по маршруту и границе
│   ├── router.js               # ORS (directions, matrix) + FOSSGIS OSRM
│   └── gazetteer.js            # подсказки пунктов, сопоставление места объявления
├── match/
│   ├── criteria.js             # проверка условий поиска (чистая функция)
│   └── format.js               # тексты: карточка, уведомление, подписи расстояний
├── jobs/
│   ├── tick.js                 # аренда, бюджет, порядок шагов
│   ├── deliver.js  poll-feeds.js  ingest.js  match.js  route.js
│   └── daily.js                # курс, чистка, отметки номеров, robots.txt
├── telegram/
│   ├── api.js                  # клиент Bot API
│   ├── webhook.js              # доступ, /start, приглашения, действия владельца
│   └── owner-alerts.js         # сообщения о сбоях источников
├── http/
│   ├── router.js
│   ├── miniapp-auth.js         # проверка initData
│   ├── api.js                  # /api/* (contracts/miniapp-api.md)
│   └── app-page.js             # /app: HTML + подстановка дизайн-системы
└── app/
    ├── index.html              # мини-приложение: только ds-*
    └── app.js
tests/
├── design-system.test.mjs      # уже есть; проверяет src/app/
├── fixtures/{kufar,realt,domovita,moyareklama}/   # сохранённые страницы
├── sources/*.test.mjs          # адаптеры
├── unit/*.test.mjs             # критерии, расстояния, нормализация, robots, initData, тексты
└── e2e/*.e2e.mjs               # Miniflare: полный цикл (npm run test:e2e)
README.md                       # установка, секреты, команды, атрибуция OSM/ORS
```

**Structure Decision**: один проект — Worker и мини-приложение в одном репозитории. Мини-приложение — статические
`src/app/*`, их отдаёт тот же Worker с подставленной дизайн-системой. Каталог `design-system/` остаётся
единственным источником стилей. Сквозные тесты называются `*.e2e.mjs`, чтобы `npm test` (`tests/**/*.test.mjs`)
оставался быстрым.

## Complexity Tracking

Нарушений Конституции нет.
