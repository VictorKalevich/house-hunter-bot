---

description: "Задачи реализации: уведомления о новых домах с участками"
---

# Tasks: Уведомления о новых домах с участками

**Input**: Документы проектирования из `specs/001-house-listing-alerts/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: обязательны — Конституция, принцип V: разбор каждого сайта на сохранённых страницах, фильтры и расстояния
— юнит-тесты, сквозной тест перед выкатом. Тесты истории пишутся первыми и должны падать до реализации.

**Organization**: задачи сгруппированы по историям спецификации, чтобы каждую можно было сделать и проверить
отдельно.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: можно делать параллельно (другие файлы, нет зависимости от незаконченных задач)
- **[Story]**: история спецификации (US1…US6)
- Ограничения полей — по [data-model.md](data-model.md), ссылка вида `таблица.поле`; в задаче повторяется только то,
  что сужает или дополняет каноническое правило

## Path Conventions

Один проект в корне репозитория (plan.md, «Project Structure»): `src/`, `tests/`, `migrations/`, `seeds/`, `scripts/`,
`design-system/` (уже есть, единственный источник стилей).

Перед кодом, который использует Cloudflare Workers, D1, Wrangler, Miniflare или Telegram Bot API, — документация
через Context7 (CLAUDE.md, Конституция «Процесс разработки»).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: инструменты и настройки проекта

- [ ] T001 Обновить `package.json`: devDependencies `wrangler` 4.x и `miniflare` 4.x (версии сверить через Context7 и `npm view`); скрипты `test` (как есть), `test:e2e` (`node --test "tests/e2e/**/*.e2e.mjs"`), `bench` (`node scripts/bench.mjs`), `dev` (`wrangler dev --test-scheduled`), `deploy` (`wrangler deploy`); `npm install` → `package-lock.json`
- [ ] T002 [P] Создать `wrangler.jsonc` по research.md R2, R8, R11: `main: src/index.js`, актуальная `compatibility_date`, `d1_databases` (binding `DB`, база `house-hunter`, `migrations_dir: migrations`), `triggers.crons: ["* * * * *", "30 0 * * *"]`, `rules` типа `Text` для `**/*.css` и `src/app/*.js`, `vars` `BOT_USERNAME` и `PUBLIC_URL`, `observability.enabled: true`
- [ ] T003 [P] Создать `.dev.vars.example` с именами секретов `BOT_TOKEN`, `WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`, `ORS_API_KEY` без значений; проверить, что `.dev.vars` есть в `.gitignore`
- [ ] T004 [P] Создать `src/config.js`: `USER_AGENT` (`house-hunter-bot/<версия> (+https://t.me/<BOT_USERNAME>)`), бюджеты тика (CPU-единиц 6, подзапросов 45, отправок 20, отбор 50 объявлений, маршрутов 10), ожидания (отбор 20 мин, зависшая отправка 10 мин, аренда тика 5 мин, тайм-аут запроса 15 с), сроки хранения (объявления 30 дней, уведомления 365 дней), свежесть `initData` 24 ч, лимиты ORS (2 000 / 500 в сутки, 40 в минуту) и OSRM (300 в сутки, 1 в секунду) — значения из plan.md и research.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: база, маршрутизация, доступ, тик, справочник пунктов, сквозной стенд — нужны всем историям

**⚠️ CRITICAL**: истории начинаются только после этой фазы

- [ ] T005 Написать `migrations/0001_init.sql` — все таблицы и индексы data-model.md с ограничениями (PK, UNIQUE, NOT NULL, CHECK по перечислениям и диапазонам, DEFAULT): `users.telegram_id`, `users.first_name`, `users.role`, `users.access`, `users.invited_by`, `users.created_at`; `access_denials.telegram_id`, `access_denials.attempts`; `invites.token`, `invites.created_by`, `invites.used_by`; `settlements.id`, `settlements.osm_ref`, `settlements.name`, `settlements.name_norm` (индекс), `settlements.kind`, `settlements.region`, `settlements.lat`, `settlements.lon`, `settlements.rank`; `settlement_shapes.settlement_id`, `settlement_shapes.polygon`, `settlement_shapes.radius_km`, `settlement_shapes.source`; `sources.id`, `sources.state`, `sources.error_kind`; `feeds.id`, `feeds.source`; `listings.id`, `listings.source` + `listings.external_id` (UNIQUE пара), `listings.url`, `listings.place_text`, `listings.geo_approx`, `listings.is_new`, `listings.sort_at`, `listings.first_seen_at`, `listings.last_seen_at`, `listings.match_state`, `listings.needs_detail` и индексы `listings` из data-model; `searches.id`, `searches.user_id`, `searches.title`, `searches.distance_mode`, `searches.max_km`, `searches.sources`, `searches.status`, `searches.active_since`; `distances.settlement_id` + `distances.geo_key` (PK), `distances.straight_km`, `distances.status`; `notifications.id`, `notifications.user_id` + `notifications.source` + `notifications.external_id` (UNIQUE), `notifications.listing_id`, `notifications.search_ids`, `notifications.status`, индекс `(status, next_attempt_at)`; `rates.date`, `rates.usd_byn`; `service_quota.service`, `service_quota.day`, `service_quota.used`; `locks.name` и начальная строка `tick`
- [ ] T006 [P] Создать `src/index.js` (`fetch` → `src/http/router.js`; `scheduled`: `* * * * *` → `src/jobs/tick.js`, `30 0 * * *` → `src/jobs/daily.js`) и `src/http/router.js` (`POST /telegram/webhook`, `GET /app`, `GET /app/app.js`, `/api/*`; неизвестный путь — 404; ошибки `/api/*` — JSON по contracts/miniapp-api.md «Общее»)
- [ ] T007 [P] Создать клиент Bot API `src/telegram/api.js` (метод → JSON; разбор `ok`, `error_code`, `description`, `parameters.retry_after`) и `src/telegram/html.js` (экранирование `&`, `<`, `>` для `parse_mode: HTML`); тест `tests/unit/telegram-html.test.mjs`
- [ ] T008 [P] Тест `tests/unit/miniapp-auth.test.mjs` (верная подпись, чужой токен, без `hash`, `auth_date` старше 24 ч) и проверка подписи `src/http/miniapp-auth.js` по research.md R7 (Web Crypto; результат — пользователь Telegram из `initData.user` или ошибка `unauthorized`)
- [ ] T009 Доступ в `src/telegram/webhook.js` и `src/db/users.js` по contracts/telegram-bot.md «Webhook» и «Доступ»: проверка `X-Telegram-Bot-Api-Secret-Token` (иначе 401); запись владельца — `users.role` = `owner` только для `OWNER_TELEGRAM_ID`; обновление `users.first_name` и `users.username`; очистка `users.blocked_at` при новом сообщении; `users.access` = `revoked` → «Доступ к боту закрыт владельцем.»; незнакомец → отказ и только `access_denials.first_at`, `access_denials.last_at`, `access_denials.attempts` (data-model.md); `/start` и любой текст → главное меню с кнопками `web_app` «Новый поиск» (`/app#/search/new`) и «Мои поиски» (`/app#/`) и строкой атрибуции OSM
- [ ] T010 Каркас `src/http/api.js`: подпись через `src/http/miniapp-auth.js`, доступ по `users.access` (data-model.md; не `active` и не владелец → 403 `no_access`), `GET /api/me`, ошибки по contracts/miniapp-api.md «Общее»
- [ ] T011 [P] Страница мини-приложения: `src/http/app-page.js` (текстовые модули `src/app/index.html`, `src/app/app.js`, `design-system/tokens.css`, `design-system/components.css`; CSS — на место `/*@design-system*/`; `Cache-Control: no-cache`), каркас `src/app/index.html` (`ds-root`, скрипт `telegram-web-app.js`, `<style>/*@design-system*/</style>`, контейнер экранов, подвал с атрибуцией OSM) и `src/app/app.js` (`Telegram.WebApp.ready()`/`expand()`, `api()` с заголовком `Authorization: tma <initData>`, роутер по hash, `ds-toast`, `BackButton`, вывод текста только через `textContent`); `npm test` (проверка `src/app/` в `tests/design-system.test.mjs`) — зелёный
- [ ] T012 [P] Тик `src/jobs/tick.js` и `src/db/locks.js`: аренда по `locks.holder` и `locks.expires_at` (data-model.md locks), объект бюджета (CPU-единицы, подзапросы, не больше одного запроса к сайту), шаги по порядку plan.md «Как работает тик» (список пока пуст), одна строка JSON-лога на тик с `rows_read`/`rows_written` из `meta` D1
- [ ] T013 [P] Каркас суточной задачи `src/jobs/daily.js`: шаги регистрируются историями, ошибка одного шага не мешает остальным, итог — строка лога
- [ ] T014 Скрипт `scripts/build-settlements.mjs` по research.md R4: Overpass с параметром `--overpass-url`; пункты `place=city|town|village|hamlet|isolated_dwelling` Беларуси; русские названия районов и областей по границам `admin_level` 6 и 4; полигоны городов, посёлков и агрогородков с упрощением Дугласа–Пекера 30 м; окружности остальным (хутор 0,15 км, деревня 0,4 км, прочее 0,5 км); заполняет `settlements.osm_ref`, `settlements.name`, `settlements.name_norm`, `settlements.kind`, `settlements.district`, `settlements.region`, `settlements.lat`, `settlements.lon`, `settlements.rank`, `settlement_shapes.polygon`, `settlement_shapes.radius_km`, `settlement_shapes.source` (data-model.md); пишет `seeds/settlements.sql`; запустить и закоммитить сид
- [ ] T015 [P] Справочник `src/geo/gazetteer.js` и тест `tests/unit/gazetteer.test.mjs` по research.md R5: нормализация как у `settlements.name_norm` (нижний регистр, ё → е, снятие «д.», «аг.», «г.п.», «п.», «х.», «г.», «р-н» → «район»); подсказки по началу названия, не больше 10, порядок по `settlements.rank`, в ответе `settlements.district` и `settlements.region`; сопоставление места объявления по названию + району + области, неоднозначно → не найдено
- [ ] T016 [P] Скрипт `scripts/setup-telegram.mjs` по contracts/telegram-bot.md: `setWebhook` (`secret_token`, `allowed_updates: ["message", "callback_query"]`), `setMyCommands` (`/start`), `setChatMenuButton` (`web_app` «Поиски» → `PUBLIC_URL/app`)
- [ ] T017 Сквозной стенд `tests/e2e/harness.mjs` (Miniflare): сборка Worker'а, локальная D1, применение `migrations/` и маленького сида пунктов, `outboundService` с подменой сайтов (ответы из `tests/fixtures/` с возможностью подставить свои объявления), Telegram (запись вызовов, заданные ответы), ORS, OSRM и НБ РБ; помощники `tick()`, `daily()`, `webhook(update)`, `api(user, method, path, body)` с подписанным `initData`
- [ ] T018 Сквозной тест `tests/e2e/access.e2e.mjs`: webhook без секрета → 401; незнакомец → отказ, в D1 только `access_denials`; владелец → главное меню; `GET /app` — HTML со встроенной дизайн-системой; `/api/me` без подписи → 401, незнакомец с подписью → 403

**Checkpoint**: основа готова — можно начинать истории

---

## Phase 3: User Story 1 — Настроить поиск и получать уведомления о новых объявлениях (Priority: P1) 🎯 MVP

**Goal**: пользователь создаёт поиск в мини-приложении (способ «по прямой») и получает одно сообщение о каждом новом
подходящем объявлении с kufar.by, realt.by, domovita.by и moyareklama.by.

**Independent Test**: создать поиск, на имитации сайта опубликовать одно подходящее и одно неподходящее новое
объявление — пользователь получает ровно одно сообщение, о подходящем (`tests/e2e/notify.e2e.mjs`).

### Tests for User Story 1 ⚠️

> Пишутся первыми и должны падать до реализации

- [ ] T019 [P] [US1] `tests/unit/criteria.test.mjs`: границы включительные, неуказанное поле не отсекает, при `searches.max_km` без места — не подходит, фильтр по `searches.sources`, для уведомлений — `listings.is_new` = 1 и `listings.first_seen_at` ≥ `searches.active_since` (data-model.md searches, «Правила»)
- [ ] T020 [P] [US1] `tests/unit/normalize.test.mjs`: BYN → $ по курсу (`listings.price_usd`), «договорная» и 0 → NULL, га и м² → сотки (`listings.plot_sotki`), `listings.geo_key` (4 знака), `listings.sort_at`, `listings.is_new` по `idKind` и `sources.new_id_floor`, первый опрос источника → 0, ссылка не на домен источника → объявление отброшено (`listings.url`)
- [ ] T021 [P] [US1] `tests/unit/format.test.mjs`: уведомление по contracts/telegram-bot.md «Уведомление» — цена $ / BYN / «цена не указана», «дом: не указано», подписи расстояния и «≈», список поисков, экранирование, кнопка «Открыть объявление», `link_preview_options` с фото и без
- [ ] T022 [P] [US1] `tests/unit/robots.test.mjs` и `tests/fixtures/robots/{kufar,realt,domovita,moyareklama}.txt`: `Allow`/`Disallow` с `*` и `$`, самое длинное правило, группы `User-agent`; все адреса лент адаптеров разрешены, адреса с параметрами сортировки и `/search/` закрыты
- [ ] T023 [P] [US1] `tests/unit/haversine.test.mjs`: известные пары точек, границы отбора по широте и долготе для радиуса
- [ ] T024 [P] [US1] Сохранённые ответы kufar в `tests/fixtures/kufar/` (выдача на 30 объявлений, страница по курсору, ответ-ошибка) — из файлов исследования в scratchpad, если они есть, иначе скачать по research.md R1 (честный User-Agent, паузы); имена продавцов, телефоны и e-mail заменить заглушками; тест `tests/sources/kufar.test.mjs` по contracts/source-adapter.md «Тесты»
- [ ] T025 [P] [US1] Сохранённые страницы realt в `tests/fixtures/realt/` (страница региона, страница Минской области, страница-ошибка), обезличить `contactPhones`, `contactName`, `contactEmail`; тест `tests/sources/realt.test.mjs`: платные помечены, `createdAt` → `siteCreatedAt`, значения `objectType` расшифрованы, чужие типы отброшены
- [ ] T026 [P] [US1] Сохранённые ответы domovita в `tests/fixtures/domovita/` (JSON `_next/data`, HTML с `buildId`, «чужой раздел» с `OFlatsSale`), обезличить `contacts`; при сборе проверить и записать в research.md R1 слаги четырёх областей, входят ли дачи в `/houses/sale` (если нет — ленты дач), единицы `area_ground`, нужен ли заголовок `x-nextjs-data`; тест `tests/sources/domovita.test.mjs`
- [ ] T027 [P] [US1] Сохранённые страницы moyareklama в `tests/fixtures/moyareklama/` (раздел, подраздел, карточка с `ads_geo_lat`/`ads_geo_lng`), обезличить; проверить `sitemap7.xml` (есть ли новые объявления с `lastmod`) и записать решение в research.md R1; тест `tests/sources/moyareklama.test.mjs`: заголовок «Дом 235 м² на участке 6,9 сот.», цена «312 000 р.», адрес, платные, фото из `style`
- [ ] T028 [US1] Сквозной тест `tests/e2e/notify.e2e.mjs` по quickstart.md §4: поиск «до 30 км по прямой, до 80 000 $, дом от 80 м², участок от 10 сот.» и одно подходящее новое + одно неподходящее → ровно одно `sendMessage`; повтор тика и поднятие того же объявления → второго нет; 50 старых (не новых на сайте) → уведомлений нет; Telegram 500, затем 200 → одно сообщение в следующем тике; 403 → `undeliverable` и `users.blocked_at`; страница защиты сайта → источник `blocked`, следующий запрос к нему не раньше чем через час

### Implementation for User Story 1

- [ ] T029 [P] [US1] `src/sources/robots.js` — разбор robots.txt и `isAllowed(url, userAgent)` (research.md R1 «Общее»); тест T022 — зелёный
- [ ] T030 [P] [US1] `src/geo/haversine.js` — расстояние по прямой и границы отбора по широте и долготе для радиуса; тест T023 — зелёный
- [ ] T031 [P] [US1] `src/match/criteria.js` — чистая проверка условий по data-model.md: `searches.price_min_usd`/`searches.price_max_usd`, `searches.house_min_m2`/`searches.house_max_m2`, `searches.plot_min_sotki`/`searches.plot_max_sotki`, `searches.sources`, `searches.max_km` с `searches.distance_mode`, `searches.active_since`; расстояние передаётся снаружи; тест T019 — зелёный
- [ ] T032 [P] [US1] `src/match/format.js` — текст уведомления, кнопка и превью по contracts/telegram-bot.md, подпись расстояния для `notifications.distance_label` (data-model.md); тест T021 — зелёный
- [ ] T033 [P] [US1] `src/db/rates.js` и шаг курса в `src/jobs/daily.js` по research.md R6: `GET https://api.nbrb.by/exrates/rates/USD?parammode=2&ondate=…` → `rates.date`, `rates.usd_byn`, `rates.fetched_at` (data-model.md); нет курса на сегодня — последний известный
- [ ] T034 [US1] `src/sources/normalize.js` — RawListing → строка `listings` по data-model.md: `listings.price_usd` и `listings.price_byn` (пересчёт BYN по `rates`), `listings.house_m2`, `listings.plot_sotki`, `listings.lat`/`listings.lon`, `listings.geo_approx`, `listings.geo_key`, `listings.settlement_id` (через `src/geo/gazetteer.js`), `listings.place_text`, `listings.url`, `listings.photo_url`, `listings.published_at`, `listings.site_created_at`, `listings.is_new`, `listings.sort_at`, `listings.needs_detail`; тест T020 — зелёный
- [ ] T035 [P] [US1] Адаптер `src/sources/kufar.js` по research.md R1 и contracts/source-adapter.md: одна лента, курсор, цены в центах, `coordinates` = [lon, lat], типы объектов, `idKind: numeric`; тест T024 — зелёный
- [ ] T036 [P] [US1] Адаптер `src/sources/realt.js`: 12 лент, `?page=2`, `__NEXT_DATA__` через `indexOf`, `priceRates`, `location` = [lon, lat], платные по `paymentStatus`, `idKind: created_at`, `cost` 2 и 5; тест T025 — зелёный
- [ ] T037 [P] [US1] Адаптер `src/sources/domovita.js`: 7 лент (и дачи по итогам T026), `_next/data/{buildId}`, `buildId` из HTML с остановкой чтения потока, 404 → обновить `buildId` в `sources.adapter_state` (data-model.md), проверка раздела, `idKind: created_at`; тест T026 — зелёный
- [ ] T038 [P] [US1] Адаптер `src/sources/moyareklama.js`: 6 лент, только первая страница, разбор строк по известной разметке, `detailRequest`/`parseDetail` для координат, `idKind: numeric`; тест T027 — зелёный
- [ ] T039 [US1] Реестр `src/sources/index.js`, `src/db/feeds.js` и `src/db/sources.js`: строки лент и источников создаются из адаптеров при первом запуске; чтение и запись по data-model.md `feeds.next_poll_at`, `feeds.page`, `feeds.page_cursor`, `feeds.prev_ids`, `feeds.last_ok_at`, `sources.state`, `sources.last_request_at`, `sources.consecutive_failures`, `sources.error_kind`, `sources.error_text`, `sources.failing_since`, `sources.backoff_level`, `sources.last_ok_at`, `sources.last_checked_at`, `sources.adapter_state`, `sources.robots_checked_at`
- [ ] T040 [US1] Шаг `src/jobs/poll-feeds.js` по contracts/source-adapter.md: просроченные ленты в пределах бюджета (сумма `cost` ≤ 6, к сайту — один запрос за тик, `sources.last_request_at` не ближе минуты); сверка robots.txt перед опросом, если `sources.robots_checked_at` старше 26 ч (закрыто → `disallowed`); честные заголовки и тайм-аут 15 с; классификация `ok`/`failing`/`blocked`/`disallowed` и `sources.backoff_level` (1 → 2 → 4 → 8 → 24 ч) без смены адресов и заголовков; следующая страница по правилу `feeds.prev_ids`; карточки moyareklama для `listings.needs_detail` = 1 в том же лимите запроса; подключить шаг к `src/jobs/tick.js`
- [ ] T041 [US1] Шаг `src/jobs/ingest.js`: upsert одним `db.batch()` по паре `listings.source` + `listings.external_id`; новым — `listings.first_seen_at` и `listings.match_state` (`pending`, если `listings.is_new` = 1, иначе `done`); повторным — обновить цену и площади, `listings.last_seen_at` не чаще раза в сутки; обновить `sources.max_id_seen` (data-model.md)
- [ ] T042 [US1] Шаг `src/jobs/match.js` и чтение активных поисков в `src/db/searches.js`: до 50 `pending`-объявлений × поиски пользователей с `users.access` = `active`; расстояние по прямой для `searches.distance_mode` = `straight`; ожидание карточки по `listings.needs_detail` и `listings.match_waiting_since` (≤ 20 мин); группировка по пользователю → `INSERT OR IGNORE` в `notifications` (`notifications.listing_id`, `notifications.search_ids`, `notifications.distance_label`, `notifications.status` = `pending`) и `listings.match_state` = `done` в одном `db.batch()` (research.md R9); подключить к `src/jobs/tick.js`
- [ ] T043 [US1] Шаг `src/jobs/deliver.js` и `src/db/notifications.js` по contracts/telegram-bot.md «Обработка ответа Telegram» и data-model.md notifications: захват `pending → sending`, `sendMessage`, `notifications.status` (`sent`, `failed`, `undeliverable`, `uncertain` для зависших в `sending` дольше 10 мин), `notifications.attempts`, `notifications.next_attempt_at` (1, 5, 15, 60 мин; на 429 — `retry_after` и стоп отправки в тике), `notifications.last_error`, `notifications.sent_at`, `users.blocked_at` на 403; не больше 20 за тик и одного в секунду в чат; пропуск пользователей с `users.blocked_at`; подключить первым шагом к `src/jobs/tick.js`
- [ ] T044 [US1] Суточные шаги в `src/jobs/daily.js`: удаление `listings` с `listings.last_seen_at` старше 30 дней и `notifications` с `notifications.created_at` старше года; смена отметок `sources.new_id_floor` ← `sources.id_snapshot` ← `sources.max_id_seen`; сверка robots.txt всех источников (`sources.robots_checked_at`, переход в `disallowed` и обратно) (data-model.md sources)
- [ ] T045 [US1] Создание поиска в `src/http/api.js` и `src/db/searches.js` по contracts/miniapp-api.md: `GET /api/settlements?q=`, `POST /api/searches`, `GET /api/searches/{id}`; проверка `Criteria` (422 с `fields`) по data-model.md — `searches.settlement_id` (обязателен при `searches.max_km`), `searches.max_km`, `searches.price_min_usd`/`searches.price_max_usd`, `searches.house_min_m2`/`searches.house_max_m2`, `searches.plot_min_sotki`/`searches.plot_max_sotki`, `searches.distance_mode` (в этой истории разрешён только `straight`), `searches.sources` (по умолчанию все четыре); `searches.title` из условий; `searches.status` = `active`, `searches.active_since` = сейчас, `searches.created_at`; чужой поиск — 404
- [ ] T046 [US1] Экран «Новый поиск» (`#/search/new`) в `src/app/index.html` и `src/app/app.js` по contracts/miniapp-api.md «Экраны»: `ds-field` + `ds-suggest` (название, район, область), `ds-options` со способом «по прямой от центра», `ds-affix` (км), `ds-range` с `ds-affix` ($, м², сот.), сохранение (`MainButton` или `ds-btn--block`) → итог поиска и `ds-toast` «Поиск сохранён»; ошибки 422 — `ds-input--error` и `ds-field__hint`; только `ds-*`, текст через `textContent`; недостающий элемент — сначала в дизайн-систему (токен → компонент → `design-system/preview.html` → `design-system/README.md`)
- [ ] T047 [US1] `scripts/bench.mjs`: время разбора каждой сохранённой страницы адаптером (прогрев, медиана 20 прогонов) против `cost` ленты и предела 8 мс, ошибка при превышении; по замеру поправить `cost` в адаптерах (research.md R2)
- [ ] T048 [US1] Прогнать `npm test`, `npm run bench` (`scripts/bench.mjs`), `npm run test:e2e` (`tests/e2e/access.e2e.mjs`, `tests/e2e/notify.e2e.mjs`) — всё зелёное

**Checkpoint**: MVP — поиск создаётся, новые подходящие объявления с четырёх сайтов приходят по одному разу

---

## Phase 4: User Story 2 — Посмотреть подходящие объявления в боте (Priority: P2)

**Goal**: в мини-приложении список поисков и список подходящих объявлений по 5 на странице, от новых к старым.

**Independent Test**: загрузить сохранённые страницы сайтов, создать поиск и открыть список — в нём только
подходящие объявления, по дате, по страницам (`tests/e2e/listings.e2e.mjs`).

### Tests for User Story 2 ⚠️

- [ ] T049 [P] [US2] `tests/unit/listing-card.test.mjs`: строка `listings` → `ListingCard` по contracts/miniapp-api.md (null-поля, `distance.approx`, источник, дата)
- [ ] T050 [P] [US2] `tests/e2e/listings.e2e.mjs`: ленты из сохранённых страниц → поиск → `GET /api/searches/{id}/listings`: только подходящие, в том числе старые; порядок по `listings.sort_at` от новых к старым; по 5; `total`; `page=2`; пусто → `total: 0`

### Implementation for User Story 2

- [ ] T051 [US2] Запрос списка в `src/db/listings.js` по contracts/miniapp-api.md «Список объявлений»: `listings.last_seen_at` за последние 30 дней, отбор по `listings.lat` (индекс) и равнопромежуточному приближению расстояния, условия поиска с правилом «не указано — проходит», `listings.sort_at` DESC, `LIMIT 5 OFFSET`, `COUNT`; не больше ~3 000 прочитанных строк на страницу (data-model.md «Лимиты D1»)
- [ ] T052 [US2] `GET /api/searches` и `GET /api/searches/{id}/listings` в `src/http/api.js`; сборка `ListingCard` в `src/match/format.js` (точное расстояние гаверсинусом); тест T049 — зелёный
- [ ] T053 [US2] Экран «Мои поиски» (`#/`) в `src/app/index.html` и `src/app/app.js`: `ds-hero`, `ds-list` и `ds-list-item--link`, `ds-chip--success`/`ds-chip--warning` («Активен»/«Пауза» по `searches.status`), `ds-btn--block` «Новый поиск», `ds-empty`, если поисков нет
- [ ] T054 [US2] Экран «Объявления поиска» (`#/search/{id}/listings?page=n`) и кнопка «Показать объявления» на экране поиска: `ds-listing` (`__photo`/`__photo--empty`, `__price`, `__price-alt`, `__facts`, `__place`, `__meta`), `ds-fact` с `ds-fact__value--unknown` для «не указано», `ds-chips` (сайт), `ds-pager` («Назад», «1–5 из 37», «Дальше»), `ds-spinner`, `ds-empty` с кнопкой «Изменить условия»; ссылка — `Telegram.WebApp.openLink`; только `ds-*`
- [ ] T055 [US2] Прогнать `npm test` и `npm run test:e2e` (`tests/e2e/listings.e2e.mjs` и тесты US1) — зелёные

**Checkpoint**: US1 и US2 работают каждая сама по себе

---

## Phase 5: User Story 3 — Переключать способ подсчёта расстояния (Priority: P2)

**Goal**: три способа — по прямой, по дороге от центра, по дороге от выезда; переключение сразу меняет список и
следующие уведомления.

**Independent Test**: на трёх заранее известных объявлениях переключить способ — расстояние в карточке и набор
подходящих меняются как ожидается (`tests/e2e/distance.e2e.mjs`).

### Tests for User Story 3 ⚠️

- [ ] T056 [P] [US3] `tests/unit/polyline.test.mjs`: декодирование polyline точности 5 на примерах ORS и OSRM
- [ ] T057 [P] [US3] `tests/unit/polygon.test.mjs`: точка в полигоне с дырами, bbox, окружность при `settlement_shapes.source` = `circle` (data-model.md)
- [ ] T058 [P] [US3] `tests/unit/exit-distance.test.mjs`: маршрут пересекает границу → доля за границей × длина маршрута; повторный заезд — сумма всех внешних отрезков; место внутри границы → 0 (US3, сценарий 3); нижняя оценка для отбора — прямая минус `settlement_shapes.radius_km`
- [ ] T059 [P] [US3] `tests/unit/router.test.mjs` и `tests/fixtures/routing/*.json` (ORS directions и matrix, ошибка «routable point», 403 исчерпанной квоты, 429, ответ OSRM): разбор, `preference: "fastest"`, переход на OSRM, учёт `service_quota.used` и `service_quota.paused_until`
- [ ] T060 [US3] `tests/e2e/distance.e2e.mjs`: 25 км по прямой и 38 км по дороге при лимите 30 км — объявление уходит при переключении на «по дороге от центра», подпись меняется (US3, сценарий 1); «от выезда» не включает путь по пункту (сценарий 2); место внутри пункта → 0 км (сценарий 3); маршрут не построен → по прямой с пометкой; пока считается — `distance.pending`

### Implementation for User Story 3

- [ ] T061 [P] [US3] `src/geo/polyline.js` и `src/geo/polygon.js` (декодирование границы из `settlement_shapes.polygon`, окружность по `settlement_shapes.radius_km`); тесты T056, T057 — зелёные
- [ ] T062 [US3] `src/geo/exit-distance.js` по research.md R3 «От выезда»; тест T058 — зелёный
- [ ] T063 [US3] `src/geo/router.js` по research.md R3: ORS `POST /directions/driving-car/json` (`preference: "fastest"`, `instructions: false`) и `POST /matrix/driving-car` (`metrics: ["distance"]`, 1 источник × до 3 499 целей) с ключом `ORS_API_KEY`; FOSSGIS OSRM — запасной (≤ 1 запроса в секунду); квоты по `service_quota.day`, `service_quota.used`, `service_quota.paused_until` (data-model.md); тест T059 — зелёный
- [ ] T064 [US3] `src/db/distances.js`: постановка пар с отбором по нижней оценке (`distances.straight_km`, `settlement_shapes.radius_km`) и чтение готовых; поля data-model.md `distances.settlement_id` + `distances.geo_key`, `distances.road_center_km`, `distances.road_exit_km`, `distances.status`, `distances.attempts` (после 3 → `failed`), `distances.requested_at`, `distances.computed_at`
- [ ] T065 [US3] Шаг `src/jobs/route.js`: до 10 пар за тик в бюджете подзапросов; сначала пары объявлений, ждущих отбора, потом заполнение списков (matrix для `road_center`, directions для `road_exit`); подключить к `src/jobs/tick.js`
- [ ] T066 [US3] Способы `road_center` и `road_exit` в `src/jobs/match.js`: расстояния нет → пара в очередь и `listings.match_waiting_since`; ждёт дольше 20 мин или `distances.status` = `failed` → по прямой с пометкой в `notifications.distance_label`
- [ ] T067 [US3] Способы по дороге в списке `src/db/listings.js` (соединение с `distances` по `searches.settlement_id` и `listings.geo_key`; `pending` и `fallback` в `ListingCard.distance`); постановка пар для заполнения списка при создании и изменении поиска в `src/http/api.js`; в проверке `Criteria` разрешить `searches.distance_mode` = `road_center` и `road_exit`
- [ ] T068 [US3] Мини-приложение: три способа в `ds-options` с пояснениями («по прямой от центра», «по дороге от центра», «по дороге от выезда — без пути по самому пункту»), подписи расстояния в `ds-listing` («по дороге от выезда из …», «≈», «по прямой, считается») в `src/app/app.js`; атрибуция «© openrouteservice by HeiGIT» в подвале `src/app/index.html` и в главном меню `src/telegram/webhook.js`
- [ ] T069 [US3] Прогнать `npm test` и `npm run test:e2e` (`tests/e2e/distance.e2e.mjs` и предыдущие) — зелёные

**Checkpoint**: все три способа работают в списке и в уведомлениях

---

## Phase 6: User Story 4 — Управлять поисками (Priority: P3)

**Goal**: несколько поисков, изменение условий, пауза, включение, удаление, выбор сайтов.

**Independent Test**: два поиска, один на паузе, объявление подходит под оба — приходит одно сообщение от активного
(`tests/e2e/manage.e2e.mjs`).

### Tests for User Story 4 ⚠️

- [ ] T070 [US4] `tests/e2e/manage.e2e.mjs`: пауза → сообщения нет; включение → только объявления после включения (`searches.active_since`); объявление под два активных поиска → одно сообщение с обоими (FR-013); удаление → сообщений нет; выбранные сайты соблюдаются; `PUT` с неверными условиями → 422; чужой поиск → 404

### Implementation for User Story 4

- [ ] T071 [US4] `src/db/searches.js` и `src/http/api.js` по contracts/miniapp-api.md: `PUT /api/searches/{id}` (пересборка `searches.title`, `searches.updated_at`; `searches.active_since` не меняется — FR-017), `POST …/pause` (`searches.status` = `paused`), `POST …/resume` (`searches.status` = `active`, `searches.active_since` = сейчас), `DELETE` → 204 (data-model.md searches, переходы)
- [ ] T072 [US4] Экран «Изменить поиск» (`#/search/{id}`) в `src/app/index.html` и `src/app/app.js`: та же форма с условиями поиска, `ds-switch` по каждому сайту (`searches.sources` не пустой — FR-009), `ds-switch` «Пауза», `ds-btn--danger` «Удалить» с `Telegram.WebApp.showConfirm`, `ds-toast`; переход из «Мои поиски»
- [ ] T073 [US4] Прогнать `npm test` и `npm run test:e2e` (`tests/e2e/manage.e2e.mjs` и предыдущие) — зелёные

**Checkpoint**: поисками можно управлять, остальные истории не сломаны

---

## Phase 7: User Story 5 — Владелец узнаёт о сбоях источников (Priority: P3)

**Goal**: одно сообщение владельцу о сбое источника и одно — о восстановлении; остальные сайты работают.

**Independent Test**: имитировать отказ одного сайта — владелец получает одно сообщение о сбое, пользователи получают
уведомления с остальных (`tests/e2e/source-health.e2e.mjs`).

### Tests for User Story 5 ⚠️

- [ ] T074 [P] [US5] `tests/unit/owner-alerts.test.mjs`: тексты по contracts/telegram-bot.md «Сообщения владельцу о сбоях» (`http`, `parse`/`empty`, `blocked`, `disallowed`, восстановление с длительностью сбоя)
- [ ] T075 [US5] `tests/e2e/source-health.e2e.mjs`: 3 × 503 → одно сообщение владельцу, дальнейшие сбои — без новых; затем 200 → «снова работает»; страница защиты → сообщение и проверки через 1, 2, 4 ч; robots.txt закрыл адрес → `disallowed` и сообщение; остальные сайты в это время дают уведомления; кнопки «Источники» и «Проверить сейчас»

### Implementation for User Story 5

- [ ] T076 [US5] `src/telegram/owner-alerts.js` и вызовы из `src/jobs/poll-feeds.js` при переходах состояния: одно сообщение на сбой по `sources.alerted_at`, `sources.failing_since`, `sources.consecutive_failures` (3 подряд), `sources.error_kind`, `sources.error_text`; при восстановлении — «снова работает» и сброс `sources.alerted_at` (data-model.md sources, переходы); тест T074 — зелёный
- [ ] T077 [US5] Кнопки владельца в `src/telegram/webhook.js` по contracts/telegram-bot.md: «Источники» в главном меню владельца, `callback_data` `src` (состояние сайтов) и `probe:<source>` (внеочередная проверка: `feeds.next_poll_at` = сейчас, для `blocked` — одна проверка); нажатия не владельца — «Нет доступа»
- [ ] T078 [US5] Прогнать `npm test` и `npm run test:e2e` (`tests/e2e/source-health.e2e.mjs` и предыдущие) — зелёные

**Checkpoint**: владелец видит сбои сайтов

---

## Phase 8: User Story 6 — Владелец пускает людей в бота (Priority: P3)

**Goal**: одноразовые ссылки-приглашения, список пользователей, закрытие доступа.

**Independent Test**: владелец создаёт приглашение, второй аккаунт входит и создаёт поиск, третий без приглашения
получает отказ, после закрытия доступа второй аккаунт не получает уведомлений (`tests/e2e/invites.e2e.mjs`).

### Tests for User Story 6 ⚠️

- [ ] T079 [P] [US6] `tests/unit/invites.test.mjs`: `invites.token` — 16 случайных байт в base64url (22 символа), параметр `inv_<token>` не длиннее 64 символов из `A-Za-z0-9_-` (data-model.md invites)
- [ ] T080 [US6] `tests/e2e/invites.e2e.mjs`: без приглашения → отказ; приглашение → доступ и поиск; та же ссылка с другого аккаунта → отказ; закрыть доступ → уведомлений нет, ожидающие → `undeliverable`, на сообщения — «Доступ к боту закрыт владельцем.»; себе закрыть доступ нельзя; `inv:new` от не владельца → «Нет доступа»

### Implementation for User Story 6

- [ ] T081 [US6] `src/db/invites.js` по data-model.md invites: создание (`invites.token`, `invites.created_by`, `invites.created_at`) и одноразовое использование `UPDATE … WHERE used_by IS NULL` с проверкой `changes = 1` (`invites.used_by`, `invites.used_at`); тест T079 — зелёный
- [ ] T082 [US6] Вход по ссылке в `src/telegram/webhook.js`: `/start inv_<token>` → новый пользователь (`users.role` = `member`, `users.access` = `active`, `users.invited_by`); у кого доступ уже есть — приглашение не тратится; использованное или неизвестное → отказ и `access_denials`
- [ ] T083 [US6] Действия владельца в `src/telegram/webhook.js` и `src/db/users.js` по contracts/telegram-bot.md: «Пригласить» (`inv:new`), «Пользователи» (`users:<offset>`, по 10), «Закрыть доступ» (`rv:<id>` → подтверждение `rv!:<id>`): `users.access` = `revoked`, `users.revoked_at`, ожидающие `notifications.status` → `undeliverable`; закрыть доступ себе нельзя
- [ ] T084 [US6] Прогнать `npm test` и `npm run test:e2e` (`tests/e2e/invites.e2e.mjs` и предыдущие) — зелёные

**Checkpoint**: все истории работают

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: документация, безопасность, лимиты, проверка на живом боте

- [ ] T085 [P] Создать `README.md` (Конституция, «Процесс разработки»): что делает бот; установка и выкат по quickstart.md; секреты; команды `npm test`, `npm run test:e2e`, `npm run bench`, `npm run dev`, `npm run deploy`; пересборка справочника; правила работы с сайтами (robots.txt, частота запросов); атрибуция «Данные © участники OpenStreetMap (ODbL)» и «© openrouteservice by HeiGIT»
- [ ] T086 [P] `tests/unit/security.test.mjs`: в `tests/fixtures/` нет телефонов, имён и e-mail продавцов; `src/app/app.js` не использует `innerHTML` с данными; тексты страниц и контакты не попадают в логи тика (Конституция, «Безопасность и данные»)
- [ ] T087 `tests/e2e/budget.e2e.mjs`: сутки тиков на стенде — подзапросов на тик ≤ 45, `rows_written` за сутки в пределах оценки data-model.md «Лимиты D1», к одному сайту не чаще одного запроса в минуту (Конституция, принципы I и IV)
- [ ] T088 Пройти quickstart.md §5–6 на реальном боте вместе с владельцем (выкат и слияние в `main` — только по его команде): все источники «работает», первое уведомление ≤ 30 мин после появления объявления, в `wrangler tail` нет `exceededCpu`; итоги записать в quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: без зависимостей
- **Foundational (Phase 2)**: после Setup; блокирует все истории
- **US1 (Phase 3)**: после Foundational — MVP
- **US2 (Phase 4)**: после US1 — нужны сбор объявлений (T039–T041) и создание поиска (T045)
- **US3 (Phase 5)**: после US2 — расширяет отбор (T042) и запрос списка (T051)
- **US4 (Phase 6)**: после US2 — экран «Мои поиски» (T053) и форма (T046)
- **US5 (Phase 7)**: после US1 — переходы состояния источников в `poll-feeds` (T040); с US2–US4 не связана
- **US6 (Phase 8)**: после Foundational (webhook T009); сквозной тест T080 проверяет уведомления — после US1
- **Polish (Phase 9)**: после нужных историй

### User Story Dependencies

```text
Setup → Foundational → US1 ─┬─▶ US2 ─┬─▶ US3
                            │        └─▶ US4
                            ├─▶ US5
Foundational ───────────────┴─▶ US6 (сквозной тест — после US1)
```

### Within Each User Story

- Тесты и сохранённые страницы — первыми, падают до реализации
- Чистые модули (robots, расстояния, условия, тексты) → нормализация и адаптеры → шаги тика → API → экраны
- Последняя задача истории — прогон `npm test` и `npm run test:e2e`

### Parallel Opportunities

- Setup: T002, T003, T004
- Foundational: T006, T007, T008, T011, T012, T013, T015, T016 — разные файлы
- US1: тесты T019–T027 вместе; модули T029–T033 вместе; адаптеры T035–T038 вместе (каждый — после своего теста)
- US2: T049 и T050; US3: T056–T059; US5: T074; US6: T079
- US5 и US6 можно вести параллельно с US2–US4: файлы `poll-feeds`/`owner-alerts` и `webhook`/`invites` не пересекаются с экранами мини-приложения

---

## Parallel Example: User Story 1

```text
# Тесты и сохранённые страницы — вместе:
Task: "T019 tests/unit/criteria.test.mjs"
Task: "T022 tests/unit/robots.test.mjs + tests/fixtures/robots/"
Task: "T024 tests/fixtures/kufar/ + tests/sources/kufar.test.mjs"
Task: "T025 tests/fixtures/realt/ + tests/sources/realt.test.mjs"
Task: "T026 tests/fixtures/domovita/ + tests/sources/domovita.test.mjs"
Task: "T027 tests/fixtures/moyareklama/ + tests/sources/moyareklama.test.mjs"

# Адаптеры — вместе, после своих тестов:
Task: "T035 src/sources/kufar.js"
Task: "T036 src/sources/realt.js"
Task: "T037 src/sources/domovita.js"
Task: "T038 src/sources/moyareklama.js"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup
2. Phase 2: Foundational (справочник пунктов T014 — заранее: Overpass бывает перегружен)
3. Phase 3: US1
4. **Стоп и проверка**: `npm test`, `npm run bench`, `npm run test:e2e`; выкат и проверка в Telegram — по команде
   владельца (quickstart.md §5–6)

### Incremental Delivery

1. Setup + Foundational → основа
2. US1 → уведомления по прямой (MVP)
3. US2 → список в мини-приложении
4. US3 → расстояния по дороге и «от выезда»
5. US4 → управление поисками
6. US5 → сообщения о сбоях сайтов
7. US6 → приглашения
8. Polish → README, безопасность, лимиты, проверка на живом боте

Каждая история — отдельный коммит после зелёных тестов (CLAUDE.md: коммит после `implement` — только при зелёном
`npm test`).

---

## Notes

- [P] — разные файлы и нет зависимости от незаконченных задач
- Сайты во время разработки — только для сбора сохранённых страниц: честный User-Agent, паузы, только адреса,
  открытые в robots.txt (Конституция 1.2.0, принцип I)
- Сохранённые страницы обезличиваются до коммита: имена, телефоны и e-mail продавцов — заглушки
- Любой интерфейс — только `ds-*`; недостающий элемент — сначала в дизайн-систему (принцип VII)
- Влить ветку в `main` — только по команде владельца
