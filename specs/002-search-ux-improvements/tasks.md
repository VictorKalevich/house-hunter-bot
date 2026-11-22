---

description: "Задачи реализации: тип объекта, понятный итог поиска и сайты в поиске"
---

# Tasks: Тип объекта, понятный итог поиска и сайты в поиске

**Input**: Документы проектирования из `specs/002-search-ux-improvements/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: обязательны — Конституция, принцип V: условия, проверка условий, тексты, карточка и состояние сайтов —
юнит-тесты, сквозные сценарии quickstart.md §2 — до выката. Тесты истории пишутся первыми и должны падать до
реализации. Экраны мини-приложения автоматически проверяет только `tests/design-system.test.mjs` (классы `ds-*`);
остальное — вручную в Telegram (quickstart.md §5).

**Organization**: задачи сгруппированы по историям спецификации (US1…US6), чтобы каждую можно было сделать и
проверить отдельно.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: можно делать параллельно (другие файлы, нет зависимости от незаконченных задач)
- **[Story]**: история спецификации (US1…US6)
- Ограничения полей — по [data-model.md](data-model.md), ссылка вида `таблица.поле`; в задаче повторяется только то,
  что сужает или дополняет каноническое правило

## Path Conventions

Один проект в корне репозитория, структура 001 (plan.md, «Project Structure»): `src/`, `tests/`, `migrations/`.
Мини-приложение — один файл `src/app/app.js.txt`, поэтому его задачи идут строго по порядку. Интерфейс — только
классы `ds-*` из `design-system/components.css` (принцип VII); новых компонентов фича не требует.

Документация D1 и Telegram Mini Apps уже сверена через Context7 (research.md); для другой внешней библиотеки или API
— сначала Context7 (CLAUDE.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: общие константы типов объекта

- [ ] T001 Добавить в `src/config.js`: `KINDS` — четыре типа объявления (data-model.md `listings.kind`); `KIND_GROUPS`
  — группы поиска и их типы в постоянном порядке `house`, `dacha`, `part` (data-model.md `searches.kinds`, «Группы»);
  `KIND_TITLES` — подписи «Дом», «Коттедж», «Дача», «Часть дома» (data-model.md listings, «Подписи»)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: схема базы и состояние сайтов для пользователей — нужны нескольким историям (US1, US4, US6)

**⚠️ CRITICAL**: истории начинаются только после этой фазы

- [ ] T002 Написать `migrations/0002_kinds.sql` по research.md R12: `ALTER TABLE listings ADD COLUMN` (data-model.md
  `listings.kind`) и `ALTER TABLE searches ADD COLUMN` (data-model.md `searches.kinds`); `npm run test:e2e` — сквозные
  тесты 001 зелёные на базе с 0001 и 0002 (стенд применяет все `migrations/*.sql` по порядку)
- [ ] T003 [P] Тест `tests/unit/sources-status.test.mjs`: `isConfirmedFailure` — `blocked` и `disallowed` → да;
  `failing` с 1–2 сбоями → нет, с 3 → да; `ok` → нет. Состояние для пользователей: `down` с `since` = `failing_since`;
  `collecting` — у ленты адаптера нет строки `feeds` или пуст `last_ok_at`, нет строки `sources` (до первого тика);
  сбоящий и ещё не прочитанный сайт — `down`, а не `collecting`; `ok` с `checkedAt` = `sources.last_ok_at`; порядок
  kufar, realt, domovita, moyareklama; в ответе нет `error_text`
- [ ] T004 [P] Сквозной тест `tests/e2e/sources-status.e2e.mjs` (quickstart.md §2): `GET /api/sources` до первого
  тика — все `collecting`; после кругов всех лент — `ok` с `checkedAt`; один ответ 503 — по-прежнему `ok`; три подряд —
  `down` с `since`, и в тот же тик владельцу ушло сообщение о сбое; страница защиты — сразу `down`; участник без прав
  владельца получает то же; без `initData` — 401
- [ ] T005 В `src/db/sources.js` — `isConfirmedFailure(row)` (data-model.md sources, «Состояние для пользователей»,
  `down`) и чистая функция `userSourcesStatus(sources, feeds, adapters, feedIdOf)` → `SourceStatus[]`
  (contracts/miniapp-api.md «Объекты»), адаптеры и `feedIdOf` передаются снаружи, как в `ensureStatements`. В
  `src/jobs/poll-feeds.js` `onFailure` решение «сообщить владельцу» — `isConfirmedFailure({ ...src, ...fields })`
  (FR-018: одно правило для владельца и пользователей); тесты 001 `tests/e2e/source-health.e2e.mjs` — зелёные
- [ ] T006 `GET /api/sources` в `src/http/api.js` по contracts/miniapp-api.md «Методы»: `loadSourcesAndFeeds` из
  `src/db/sources.js` + `userSourcesStatus(…, ADAPTERS, feedId)` из `src/sources/index.js`, названия — `SOURCE_TITLES`
  из `src/sources/titles.js`; для любого пользователя с доступом; `npm test` и T003, T004 — зелёные

**Checkpoint**: схема готова, `GET /api/sources` отвечает — истории можно начинать

---

## Phase 3: User Story 1 — Видеть тип объекта и отсеивать ненужные (Priority: P1) 🎯 MVP

**Goal**: тип объявления сохраняется, пишется первым словом уведомления и меткой карточки; поиск выбирает группы типов

**Independent Test**: поиск только с «Дом или коттедж»; на имитации сайта — новые подходящие дом, дача и полдома.
Приходит одно сообщение — о доме, первым словом «Дом» (spec.md US1)

### Tests for User Story 1 ⚠️

- [ ] T007 [P] [US1] `tests/unit/criteria.test.mjs`: объявление с `kind = null` проходит любой выбор типов; группа
  `house` пропускает `house` и `cottage`, но не `dacha`; поиск без поля `kinds` пропускает все типы; `matchesSearch`
  для уведомлений учитывает типы
- [ ] T008 [P] [US1] Новый `tests/unit/validate.test.mjs`: `kinds` нет → `['house', 'dacha', 'part']`; порядок
  приводится к постоянному; пустой список, не массив или неизвестное значение → `fields.kinds` «Выберите хотя бы один
  тип»
- [ ] T009 [P] [US1] `tests/unit/format.test.mjs` и `tests/unit/listing-card.test.mjs`: уведомление начинается
  «Дача · <b>45 000 $</b> · дом 40 м² · участок 6 сот.», подписи всех четырёх типов, без типа — первая строка как в
  001 (contracts/telegram-bot.md); в `ListingCard` поле `kind` (`null`, если тип неизвестен)
- [ ] T010 [P] [US1] `tests/unit/normalize.test.mjs`: `normalizeListing` переносит `kind`, значение вне четырёх
  типов → `null`; `tests/sources/{kufar,realt,domovita,moyareklama}.test.mjs` — у каждого объявления сохранённых
  страниц тип из четырёх (дописать, где такой проверки нет) — SC-001
- [ ] T011 [P] [US1] Новый сквозной тест `tests/e2e/kinds.e2e.mjs` (quickstart.md §2): поиск с `kinds: ['house',
  'part']`; в ленте kufar после первого круга — новые подходящие дом (`kufarAd({ kind: '1' })`), дача (`'10'`) и
  полдома (`'15'`) → два `sendMessage`, первые слова «Дом · » и «Часть дома · », о даче — ничего, в `/listings` дачи
  нет; поиск без `kinds` сохранён со всеми тремя, `kinds: []` → 422 `fields.kinds`; дозаполнение — у дачи через SQL
  `kind = NULL`: поиск без дач показывает её с `kind: null`, после следующего круга ленты тип записан и дачи в списке
  нет (US1-4)

### Implementation for User Story 1

- [ ] T012 [P] [US1] `src/sources/normalize.js` `normalizeListing`: поле `kind` из `RawListing.kind` (data-model.md
  `listings.kind`; значение не из `KINDS` → `null`, чтобы `CHECK` не сорвал пачку записей)
- [ ] T013 [P] [US1] `src/db/listings.js`: `'kind'` в `LISTING_COLUMNS`, `kind` в выборке `existingStatement`;
  `src/jobs/ingest.js` `changedFields`: `kind` — по правилу обновления data-model.md `listings.kind` (сайт показал
  другой тип или у строки его не было)
- [ ] T014 [P] [US1] `src/match/criteria.js`: `searchKinds(search)` (нет поля → все группы) и проверка группы типа в
  `passesFilters` (data-model.md `searches.kinds`, «Правила»: `kind = null` проходит)
- [ ] T015 [P] [US1] `src/match/validate.js` `validateCriteria`: `kinds` по contracts/miniapp-api.md «Правила
  проверки» (data-model.md `searches.kinds`); `src/db/searches.js`: `kinds` в `criteriaColumns`, `INSERT` и `UPDATE`,
  `criteria.kinds` в `searchToApi`
- [ ] T016 [US1] `src/db/listings.js` `searchListings`: условие `(l.kind IS NULL OR l.kind IN (…))` с типами выбранных
  групп (`KIND_GROUPS`) — только когда выбраны не все группы (research.md R2)
- [ ] T017 [P] [US1] `src/db/notifications.js` `duePendingStatement` — `l.kind` в выборке; `src/match/format.js`:
  тип перед ценой в `notificationMessage` (`KIND_TITLES` и « · »), `kind` в `listingCard`
- [ ] T018 [US1] `src/app/app.js.txt`: в форме блок «Тип» — три строки `ds-list-item` с `ds-list-item__body`
  (`__title`, `__meta` — тексты «Типы в форме» из contracts/miniapp-api.md) и `ds-switch`, по умолчанию все; `collect()`
  отправляет `kinds`; без единого типа — ошибка «Выберите хотя бы один тип» в `ds-hint` под блоком до отправки и из
  `fields.kinds` ответа 422; в карточке — метка типа первой в `ds-chips` строки `ds-listing__top` (подписи типов —
  своя таблица, не путать с `KIND_TITLE` населённых пунктов)
- [ ] T019 [US1] `npm test` и `npm run test:e2e` — зелёные (T007–T011 и тесты 001)

**Checkpoint**: тип в уведомлении и карточке, фильтр по типу работает — US1 проверяется сама по себе

---

## Phase 4: User Story 2 — Видеть итог поиска: условия, сколько подходит, что будет дальше (Priority: P1)

**Goal**: экран итога после сохранения и при открытии поиска; с него — объявления, изменение, пауза и удаление

**Independent Test**: создать поиск и нажать «Сохранить» — открывается итог: условия, «Сейчас подходит N» (столько
же, сколько в списке) и строка про сообщения в чат (spec.md US2)

### Tests for User Story 2 ⚠️

- [ ] T020 [P] [US2] `tests/e2e/listings.e2e.mjs`: ответ списка содержит `totalApprox: false` и `distancesPending:
  false`; после вставки одним SQL-запросом (`WITH RECURSIVE`) `LIST_MAX_ROWS` подходящих объявлений — `totalApprox:
  true`, `total` — нижняя граница
- [ ] T021 [P] [US2] `tests/e2e/distance.e2e.mjs`: поиск «по дороге», маршруты ещё не посчитаны — `distancesPending:
  true`; после тиков маршрутов — `false` (FR-007)

### Implementation for User Story 2

- [ ] T022 [US2] `src/db/listings.js` `searchListings` возвращает `totalApprox` (прочитано `LIST_MAX_ROWS` строк) и
  `distancesPending` (у подходящего объявления `distance.pending`); `src/http/api.js` — оба поля в ответе
  `GET /api/searches/{id}/listings` (contracts/miniapp-api.md «Методы»)
- [ ] T023 [US2] `src/app/app.js.txt` — адреса и переходы по contracts/miniapp-api.md «Экраны» и «Переходы»:
  `#/search/{id}` — итог (новая `showSummary`), `#/search/{id}/edit` — форма; «Назад»: итог → «Мои поиски», форма
  изменения → итог, объявления → итог; из формы убрать «Показать объявления», паузу и «Удалить поиск» (они переходят
  на итог); после «Сохранить» — `#/search/{id}` и «Поиск сохранён»; в пустом списке «Изменить условия» ведёт на
  `#/search/{id}/edit`
- [ ] T024 [US2] `showSummary(id)` в `src/app/app.js.txt` (строка «Итог поиска» contracts/miniapp-api.md «Экраны»):
  `GET /api/searches/{id}` и первая страница списка параллельно; название и метка «Активен» / «Пауза»; заданные
  условия строками — место и расстояние со способом (у старого поиска с пунктом без расстояния — «расстояние не
  ограничено»), цена, площадь дома, площадь участка, типы и сайты — если выбраны не все (FR-005); «Сейчас подходит N
  объявлений» с согласованием числа (0 — «Сейчас ничего не подходит»), «не меньше N» при `totalApprox`, «число может
  уточниться в ближайшие минуты» при `distancesPending`; «Показать объявления»; «Новые объявления пришлю сообщением в
  этот чат» или «Поиск на паузе — уведомления не приходят»; переключатель паузы меняет метку и эту строку на месте;
  «Изменить условия»; «Удалить поиск» через `confirmThen`. В списке объявлений счётчик «из N+» при `totalApprox`
- [ ] T025 [US2] `npm test` (в том числе `tests/design-system.test.mjs`) и `npm run test:e2e` — зелёные

**Checkpoint**: после «Сохранить» человек видит итог; US1 и US2 вместе — MVP фичи

---

## Phase 5: User Story 3 — Не попадать в ловушки при сохранении (Priority: P2)

**Goal**: пункт без расстояния не сохраняется; о поиске без условий бот предупреждает; способ «по дороге от центра»
подписан одинаково везде

**Independent Test**: выбрать пункт без расстояния — сохранить нельзя, у расстояния подсказка; очистить все условия —
бот просит подтверждение, «Отмена» возвращает в форму (spec.md US3)

### Tests for User Story 3 ⚠️

- [ ] T026 [P] [US3] `tests/unit/validate.test.mjs`: `settlementId` без `maxKm` → `fields.maxKm` «Укажите расстояние
  или очистите населённый пункт»; пункт с расстоянием и поиск без пункта и расстояния — без ошибок; `buildTitle` для
  `road_center` → «Минск · до 30 км по дороге от центра», остальные названия — как в 001
- [ ] T027 [P] [US3] `tests/e2e/manage.e2e.mjs`: `POST` и `PUT /api/searches` с пунктом без расстояния → 422
  `fields.maxKm`, поиск не изменился; `tests/e2e/distance.e2e.mjs` — ожидаемое название «Минск · до 30 км по дороге от
  центра»

### Implementation for User Story 3

- [ ] T028 [US3] `src/match/validate.js`: пункт без расстояния не принимается (data-model.md searches, «Правила»,
  `searches.settlement_id` и `searches.max_km`; ошибка — только у корректного `settlementId`, неверный пункт остаётся
  ошибкой `fields.settlementId`); `MODE_TITLE.road_center` — «по дороге от центра» (data-model.md `searches.title`)
- [ ] T029 [US3] `src/app/app.js.txt`, форма: подсказка расстояния зависит от выбранного пункта и меняется при выборе
  и стирании пункта (тексты contracts/miniapp-api.md «Тексты»); пункт без расстояния — ошибка у поля расстояния до
  отправки; без расстояния, цены и площадей — перед отправкой `tg.showPopup` (если `tg.isVersionAtLeast('6.2')`,
  иначе `window.confirm`) с заголовком, текстом и кнопками «Сохранить так» / «Отмена» из «Тексты» (research.md R4);
  в карточке подписи способа — «По дороге от центра», «По дороге от выезда» (FR-010)
- [ ] T030 [US3] `npm test` и `npm run test:e2e` — зелёные

**Checkpoint**: ловушки формы закрыты; US3 проверяется сама по себе

---

## Phase 6: User Story 4 — Отличать новое объявление от поднятого (Priority: P2)

**Goal**: метка «Новое» и «обновлено …» в списке; пока бот не прочитал сайты, пустой список так и говорит

**Independent Test**: в списке у нового объявления метка «Новое», у поднятого — «обновлено …» и дата размещения, если
сайт её дал; сразу после первого запуска пустой список говорит, что объявления ещё собираются (spec.md US4)

### Tests for User Story 4 ⚠️

- [ ] T031 [P] [US4] `tests/unit/listing-card.test.mjs`: `isNew` (`is_new` 1 → `true`, 0 → `false`), `createdAt`
  (`site_created_at` → ISO-строка, нет → `null`)
- [ ] T032 [P] [US4] `tests/e2e/listings.e2e.mjs`: объявления kufar первого круга — `isNew: false`, появившееся после
  него — `isNew: true`; у объявлений realt с сохранённых страниц `createdAt` есть, у kufar — `null`

### Implementation for User Story 4

- [ ] T033 [US4] `src/match/format.js` `listingCard`: `isNew` и `createdAt` (contracts/miniapp-api.md «Объекты»,
  `ListingCard`)
- [ ] T034 [US4] `src/app/app.js.txt`, карточка (research.md R7): метки тип → «Новое» (`ds-chip--brand`) → сайт; в
  `ds-listing__meta` сайта больше нет (FR-013); у нового — «размещено N назад», у остальных — «обновлено N назад» и,
  если есть `createdAt`, «· размещено 3 окт.»
- [ ] T035 [US4] `src/app/app.js.txt`, список и итог: `GET /api/sources` параллельно с остальными запросами; пустой
  список, пока среди сайтов поиска есть `collecting`, — «Бот ещё собирает объявления» и текст из contracts/miniapp-api.md
  «Тексты» (FR-012), иначе — текст 001; на итоге при N = 0 и `collecting` — та же подсказка; ошибка загрузки состояния
  сайтов экран не ломает
- [ ] T036 [US4] `npm test` и `npm run test:e2e` — зелёные

**Checkpoint**: поднятые объявления не выглядят новыми; US4 проверяется сама по себе

---

## Phase 7: User Story 5 — Понимать, что даёт каждый сайт, и держать разные условия для разных сайтов (Priority: P3)

**Goal**: подписи охвата сайтов, сайты и типы в «Мои поиски», копирование поиска

**Independent Test**: скопировать поиск, в копии оставить только moyareklama.by и поменять расстояние, сохранить — в
«Мои поиски» два поиска, у копии видно «moyareklama.by», исходный не изменился (spec.md US5)

### Tests for User Story 5 ⚠️

- [ ] T037 [P] [US5] `tests/e2e/manage.e2e.mjs`: копия так, как её делает мини-приложение — `criteria` из
  `GET /api/searches/{id}` с другими `sources` → `POST /api/searches` → 201, новый поиск включён и с `active_since` =
  время создания, исходный не изменился, в списке поисков оба; `criteria` из ответа без изменений тоже принимаются

### Implementation for User Story 5

- [ ] T038 [US5] `src/app/app.js.txt`, форма: строка сайта — `ds-list-item__body` с `__title` (сайт) и `__meta`
  (охват — «Сайты в форме» из contracts/miniapp-api.md «Тексты»), FR-014
- [ ] T039 [US5] `src/app/app.js.txt`: описание поиска в «Мои поиски» и условия на итоге перечисляют типы и сайты,
  если выбраны не все (FR-015)
- [ ] T040 [US5] `src/app/app.js.txt`, копирование (research.md R6): на итоге «Копировать поиск» → `#/search/new?copy={id}`;
  `render()` передаёт `copy` в `showForm`; форма загружает поиск, подставляет условия и пункт, заголовок «Копия:
  <название>», «Назад» → итог исходного поиска; «Сохранить» — `POST /api/searches` и итог нового поиска (FR-016)
- [ ] T041 [US5] `npm test` и `npm run test:e2e` — зелёные

**Checkpoint**: разные условия для разных сайтов — копией за минуту; US5 проверяется сама по себе

---

## Phase 8: User Story 6 — Видеть, что сайты работают (Priority: P3)

**Goal**: строка о состоянии сайтов для всех пользователей; неработающий сайт поиска — и на итоге, и в списке

**Independent Test**: подтверждённый сбой одного сайта — у приглашённого на «Мои поиски» строка, что сайт не
работает и с какого времени; после восстановления — «Все сайты работают» (spec.md US6). Сервер проверен T003–T004

### Implementation for User Story 6

- [ ] T042 [US6] `src/app/app.js.txt`, «Мои поиски»: `GET /api/sources` параллельно с `GET /api/searches`; внизу
  строка по contracts/miniapp-api.md «Тексты»: каждый сайт в `down` — `ds-card` с `ds-chip--warning` и «<сайт> не
  работает с <время> — объявления с него придут, когда он заработает» (время по часам телефона, не сегодня — с
  датой); сайты в `collecting` — «Собираю объявления в первый раз: …»; все `ok` — `ds-hint` «Все сайты работают ·
  проверены за последние N мин» (N — по самой давней проверке); ошибка загрузки — строки нет
- [ ] T043 [US6] `src/app/app.js.txt`, итог и список: строка о каждом сайте поиска в `down` (FR-019) — тот же вид,
  что на «Мои поиски»
- [ ] T044 [US6] `npm test` и `npm run test:e2e` — зелёные

**Checkpoint**: все истории готовы

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: документация, лимиты, итоговая проверка

- [ ] T045 [P] `README.md`, «Как пользоваться»: типы объекта, итог поиска, ловушки формы, копирование поиска,
  состояние сайтов; в разделе выката — миграция `npx wrangler d1 migrations apply house-hunter --remote` перед
  `wrangler deploy`
- [ ] T046 [P] Документы 001: в начале `specs/001-house-listing-alerts/contracts/miniapp-api.md` и
  `contracts/telegram-bot.md` — ссылка на изменения в `specs/002-search-ux-improvements/contracts/`; в
  `specs/001-house-listing-alerts/quickstart.md` §7 — шаг миграции 0002 перед `wrangler deploy`, если выкат идёт с
  ветки 002
- [ ] T047 `npm run bench` — CPU тика в пределах 001 (Конституция, принцип IV); `tests/e2e/budget.e2e.mjs` — записи
  D1 за сутки в пределах оценки data-model.md «Лимиты D1»
- [ ] T048 Итог: `npm test`, `npm run test:e2e`, `npm run bench` — зелёные; quickstart.md §1–2 пройдены; проверка в
  Telegram (quickstart.md §5) — после выката вместе с владельцем, в рамках T088 фичи 001

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: без зависимостей
- **Foundational (Phase 2)**: после Setup; блокирует все истории
- **US1 (Phase 3)**: после Foundational — MVP
- **US2 (Phase 4)**: после Foundational; строка типов в условиях итога — из US1 (`criteria.kinds`)
- **US3 (Phase 5)**: после US2 — форма уже на адресе `#/search/{id}/edit`
- **US4 (Phase 6)**: после US2 — подсказка «ещё собирает» и на итоге; `GET /api/sources` — из Foundational
- **US5 (Phase 7)**: после US2 — кнопка «Копировать поиск» на итоге
- **US6 (Phase 8)**: после US2 — строка о сайтах и на итоге; сервер — из Foundational
- **Polish (Phase 9)**: после всех историй

### User Story Dependencies

```text
Setup → Foundational ─┬─▶ US1 ─▶ US2 ─┬─▶ US3
                      │               ├─▶ US4
                      │               ├─▶ US5
                      └───────────────┴─▶ US6
```

Серверная часть историй независима; связывает их один файл мини-приложения `src/app/app.js.txt`, поэтому экраны
делаются по порядку историй.

### Within Each User Story

- Тесты — первыми, падают до реализации
- Нормализация и запись → условия и проверка условий → запросы к базе → API и тексты → экраны
- Последняя задача истории — прогон `npm test` и `npm run test:e2e`

### Parallel Opportunities

- Foundational: T003 и T004
- US1: тесты T007–T011 вместе; реализация T012, T013, T014, T015, T017 вместе (разные файлы)
- US2: T020 и T021; US3: T026 и T027; US4: T031 и T032
- Polish: T045 и T046
- Задачи `src/app/app.js.txt` (T018, T023, T024, T029, T034, T035, T038–T040, T042, T043) — только по порядку

---

## Parallel Example: User Story 1

```text
# Тесты — вместе:
Task: "T007 tests/unit/criteria.test.mjs — фильтр по типу"
Task: "T008 tests/unit/validate.test.mjs — kinds"
Task: "T009 tests/unit/format.test.mjs + tests/unit/listing-card.test.mjs — тип в тексте и карточке"
Task: "T010 tests/unit/normalize.test.mjs + tests/sources/*.test.mjs — тип у каждого объявления"
Task: "T011 tests/e2e/kinds.e2e.mjs — фильтр, первое слово, дозаполнение"

# Реализация — вместе, после тестов:
Task: "T012 src/sources/normalize.js"
Task: "T013 src/db/listings.js + src/jobs/ingest.js"
Task: "T014 src/match/criteria.js"
Task: "T015 src/match/validate.js + src/db/searches.js"
Task: "T017 src/db/notifications.js + src/match/format.js"
```

---

## Implementation Strategy

### MVP First (User Stories 1 и 2 — обе P1)

1. Phase 1: Setup
2. Phase 2: Foundational (миграция 0002, `GET /api/sources`)
3. Phase 3: US1 — тип объекта
4. Phase 4: US2 — итог поиска
5. **Стоп и проверка**: `npm test`, `npm run test:e2e`

### Incremental Delivery

1. Setup + Foundational → схема и состояние сайтов
2. US1 → тип в уведомлениях и фильтр (MVP)
3. US2 → итог поиска (MVP)
4. US3 → форма без ловушек
5. US4 → «Новое» и «обновлено», «ещё собирает»
6. US5 → подписи сайтов и копирование
7. US6 → состояние сайтов для всех
8. Polish → README, документы 001, лимиты, итоговая проверка

Выкат (spec.md, Assumptions): если к 2026-11-23 00:00 UTC фича готова целиком и `npm test`, `npm run test:e2e`
зелёные — T088 фичи 001 выкатывается с ветки 002 (сначала миграция, quickstart.md §4); иначе — с ветки 001, а 002 —
следом. Коммит после реализации — только при зелёном `npm test` (CLAUDE.md).

---

## Notes

- [P] — разные файлы и нет зависимости от незаконченных задач
- Новых запросов к сайтам и внешним сервисам нет (FR-020, принцип I): тип, метки и состояние — из того, что бот уже
  читает и хранит
- Пользователям не отдаются технические подробности сбоев (`error_text`) — Конституция, «Безопасность и данные»
- Любой интерфейс — только `ds-*`; текст с сайтов — через `textContent` (принцип VII, `tests/unit/security.test.mjs`)
- Влить ветку в `main` — только по команде владельца
