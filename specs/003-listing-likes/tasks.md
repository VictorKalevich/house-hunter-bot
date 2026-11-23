---

description: "Задачи реализации: понравившиеся, «Не интересно» и изменение цены"
---

# Tasks: Понравившиеся, «Не интересно» и изменение цены

**Input**: документы проектирования из `specs/003-listing-likes/`.

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md).

**Tests** обязательны по принципу V Конституции:

- Юнит-тесты: правило цены, тексты и клавиатуры, карточка, разбор страниц объявлений, валюта продавца.
- Сквозные сценарии quickstart.md §2 — до выката.
- Тесты истории пишутся первыми и должны падать до реализации.
- Экраны мини-приложения автоматически проверяет только `tests/design-system.test.mjs` (классы `ds-*`); остальное —
  вручную в Telegram (quickstart.md §5).

**Organization**: задачи сгруппированы по историям спецификации (US1…US4); каждую можно сделать и проверить отдельно.

## Format: `[ID] [P?] [Story] Description`

- **[P]** — можно делать параллельно: другие файлы, нет зависимости от незаконченных задач.
- **[Story]** — история спецификации (US1…US4).
- Ограничения полей — по [data-model.md](data-model.md), ссылка вида `таблица.поле`. В задаче повторяется только то,
  что сужает или дополняет каноническое правило.

## Path Conventions

Структура проекта — как в 001 (plan.md, «Project Structure»): один проект в корне репозитория, `src/`, `tests/`,
`migrations/`, `scripts/`.

- Мини-приложение — один файл `src/app/app.js.txt`, поэтому его задачи идут строго по порядку.
- Интерфейс — только классы `ds-*` (принцип VII); новых компонентов фича не требует (research.md R12).
- Документация D1 и Telegram Bot API сверена (research.md, вступление). Для другой внешней библиотеки или API —
  сначала Context7 (CLAUDE.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: общие константы фичи

- [X] T001 Добавить в `src/config.js`:
  - `LIKES_MAX = 100` (FR-006);
  - `CARD_CHECK_MS = DAY` — страница не чаще раза в сутки и не после выдачи за сутки (research.md R7);
  - `CARD_GAP_MS = 3 * MINUTE`, `CARD_IDLE_MS = HOUR` — data-model.md `sources.cards_next_at`;
  - `UNCHECKED_AFTER_MS = 7 * DAY` — research.md R8;
  - `PRICE_CHANGE_MIN = 0.01` — research.md R9;
  - `PRICE_ALERT_TTL_MS = 365 * DAY`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: схема, отметки, клавиатуры и вызовы Telegram — нужны всем историям

**⚠️ CRITICAL**: истории начинаются только после этой фазы

- [X] T002 Написать `migrations/0004_marks.sql` по data-model.md, только `CREATE` и `ALTER TABLE … ADD COLUMN`:
  - таблица `marks` — поля `marks.user_id`, `marks.listing_id`, `marks.kind`, `marks.created_at`; ключ, `WITHOUT
    ROWID`, индексы `marks_user`, `marks_kind`;
  - таблица `price_alerts` — поля `price_alerts.user_id`, `price_alerts.listing_id`, `price_alerts.currency`,
    `price_alerts.old_price`, `price_alerts.new_price`, `price_alerts.status`, `price_alerts.attempts`,
    `price_alerts.next_attempt_at`, `price_alerts.last_error`, `price_alerts.created_at`, `price_alerts.sent_at`;
    индексы `price_alerts_queue`, `price_alerts_created`;
  - колонки `listings.price_amount`, `listings.price_currency`, `listings.checked_at`, `listings.check_ok_at`,
    `listings.gone_at`, `sources.cards_next_at`;
  - `CHECK` — по типам полей data-model.md.

  Проверка: `npm run test:e2e` — сквозные тесты 001 и 002 зелёные на базе с 0001–0004.
- [X] T003 [P] Тесты `tests/unit/format.test.mjs` и `tests/unit/listing-card.test.mjs`:
  - `markKeyboard(listing, mark)` — три состояния по contracts/telegram-bot.md 003 «Нажатия кнопок отметок»;
    `callback_data` ≤ 64 байт при `id` в 15 цифр;
  - `notificationMessage` с отметкой `null` и `like` — две строки кнопок;
  - `listingCard` отдаёт `id` и `mark` (contracts/miniapp-api.md 003 «Объекты»).
- [X] T004 `src/match/format.js`:
  - `markKeyboard(listing, mark)` → `{ inline_keyboard }` (research.md R3);
  - `notificationMessage` принимает `mark` и строит клавиатуру через `markKeyboard`;
  - `listingCard(row, distance, { mark })` — поля `id`, `mark`.

  Проверка: T003 зелёный, прежние тесты format и listing-card зелёные.
- [X] T005 [P] Новый `src/db/marks.js`:
  - `getMark(db, userId, listingId)`;
  - `setMark(db, userId, listingId, mark, now)` по research.md R2: `mark` — `'like'` | `'hide'` | `null`.
    - Сначала проверка, что объявление есть → `{ error: 'not_found' }`.
    - Лайк — одной командой `INSERT … SELECT … WHERE (число лайков без этого объявления) < LIKES_MAX ON CONFLICT
      DO UPDATE`; `created_at` меняется только при смене вида (data-model.md `marks.created_at`); 0 изменений →
      `{ error: 'like_limit' }`.
    - `null` — удаление строки.
    - Ответ — `{ mark }`.
  - `listMarks(db, userId, kind, page)` → `{ rows, total, settlement }` одним `batch`:
    - страница по `marks_user`, `ORDER BY created_at DESC`, `LIMIT/OFFSET` по `LIST_PAGE_SIZE`;
    - `COUNT(*)`;
    - пункт самого нового поиска пользователя с `settlement_id` (research.md R11).
- [X] T006 [P] `src/telegram/api.js`:
  - `editMessageReplyMarkup(env, chatId, messageId, replyMarkup)`;
  - `answerCallbackQuery(env, id, text, { showAlert })` — `text` ≤ 200 символов (research.md, вступление).

  `src/telegram/webhook.js` `answer` — через неё.

**Checkpoint**: схема с отметками, клавиатуры и вызовы Telegram готовы — истории можно начинать

---

## Phase 3: User Story 1 — Отмечать понравившиеся и возвращаться к ним (Priority: P1) 🎯 MVP

**Goal**: лайк под сообщением и на карточке, экран «Понравившиеся» из меню бота, понравившиеся не удаляются очисткой

**Independent Test**: уведомление → «♡ Нравится» → «Понравившиеся» из меню бота: дом там, у второго пользователя —
нет (spec.md US1)

### Tests for User Story 1 ⚠️

- [X] T007 [P] [US1] Новый сквозной тест `tests/e2e/likes.e2e.mjs`, quickstart.md §2, строки 1–6.
  - **Лайк кнопкой.** Уведомление о новом доме kufar → `h.callback(OWNER, 'lk:<id>')`:
    - `answerCallbackQuery` «Добавлено в понравившиеся»;
    - `editMessageReplyMarkup` с «♥ В понравившихся» / `ul:<id>`;
    - `GET /api/marks?kind=like` — дом с `mark: 'like'`;
    - у `MEMBER` — пусто.
  - **Снятие и повтор.**
    - `ul:<id>` → лайка нет.
    - Два `lk:<id>` подряд → одна строка `marks`.
  - **Страницы.** 7 лайков через `PUT /api/listings/{id}/mark` → `page=1` — 5 последних, `total: 7`; `page=2` — 2.
  - **Удаление поисков.** Дом нашли два поиска; оба поиска удалены → дом остаётся в понравившихся.
  - **Очистка.** `h.daily()` через 40 суток → дом с лайком на месте, такой же дом без лайка удалён (SC-003).
  - **Лимит.** 100 лайков, 101-й:
    - кнопкой — окно «В понравившихся уже 100 объявлений — уберите лишние» (`show_alert`);
    - через API — `409 like_limit`.
  - **Удалённое объявление.** Кнопка на удалённый очисткой дом → окно «Объявление уже удалено из бота», без
    `editMessageReplyMarkup`.
  - **Меню.** В главном меню есть «Понравившиеся» → `/app#/liked`.
  - **Без доступа.** `STRANGER` нажимает `lk:<id>` → отказ.

### Implementation for User Story 1

- [X] T008 [US1] `src/db/notifications.js` `duePendingStatement`: `LEFT JOIN marks m ON m.user_id = n.user_id AND
  m.listing_id = n.listing_id`, `m.kind AS mark`, `l.id AS listing_row_id`. `src/jobs/deliver.js` передаёт `mark` в
  `notificationMessage` (contracts/telegram-bot.md 003 «Кнопки под уведомлением»).
- [X] T009 [US1] `src/telegram/webhook.js`:
  - кнопка меню «Понравившиеся» (`web_app` → `/app#/liked`) после «Мои поиски» для всех пользователей;
  - в `handleCallback` до проверки «только владелец» — `lk:<id>` и `ul:<id>` через `setMark`:
    - сначала `answerCallbackQuery` (тексты и окна — contracts/telegram-bot.md 003);
    - затем `editMessageReplyMarkup` по `cq.message.chat.id` и `message_id` с `markKeyboard`;
    - `url` объявления — из строки `listings`;
    - сообщение недоступно (`date = 0`) и ответ `400` «message is not modified» — не ошибка (research.md R3).
- [X] T010 [US1] `src/http/api.js`:
  - `PUT /api/listings/{id}/mark` и `GET /api/marks?kind=&page=` по contracts/miniapp-api.md 003 «Методы»: ошибки
    `404 not_found`, `409 like_limit`, `422 invalid` с `fields`;
  - карточки `GET /api/marks` — через `listingCard`. `distance` — по прямой от пункта из `listMarks` (`haversineKm`,
    `mode: 'straight'`, `approx` по `geo_approx`, `from` — название пункта); нет пункта или координат → `null`.
- [X] T011 [US1] `src/db/listings.js` `searchListings`:
  - `LEFT JOIN marks m ON m.user_id = ? AND m.listing_id = l.id` с `search.user_id`, `m.kind AS mark`;
  - вместе с `distances` — порядок `joinParams`;
  - `src/http/api.js` передаёт `mark` в `listingCard` списка поиска.
- [X] T012 [US1] `src/jobs/daily.js` `cleanupStep`: удаление объявлений — с условием «нет лайка» (data-model.md
  listings, «Очистка»; research.md R5).
- [X] T013 [US1] `src/app/app.js.txt`, по contracts/miniapp-api.md 003 «Кнопки карточки», «Экраны», «Тексты»,
  «Переходы»:
  - **кнопки карточки** — строка `ds-row ds-row--wrap` вместо одиночной «Открыть объявление»: «♡ Нравится» / «♥ В
    понравившихся» с `aria-pressed`, «Открыть объявление»; нажатие — `PUT …/mark`, кнопка недоступна до ответа,
    ошибка — `ds-toast`;
  - **экран `#/liked?page=n`** — заголовок, карточки, `ds-pager`, `ds-empty`; «Назад» → `#/`;
  - **главный экран** — кнопка «♥ Понравившиеся» под «Новый поиск»;
  - **расстояние** — подпись факта «<from>, по прямой».
- [X] T014 [US1] `npm test` и `npm run test:e2e` — зелёные: T007 и тесты 001, 002.

**Checkpoint**: лайки работают в чате и в мини-приложении, список «Понравившиеся» — US1 проверяется сама по себе

---

## Phase 4: User Story 2 — Убирать неинтересное с глаз (Priority: P2)

**Goal**: «Не интересно» скрывает дом из списков и сообщений этого пользователя; «Скрытые» и «Вернуть»

**Independent Test**: «Не интересно» на карточке списка поиска — карточка пропадает, «Сейчас подходят» на 1 меньше;
в «Скрытых» дом есть, «Вернуть» возвращает (spec.md US2)

### Tests for User Story 2 ⚠️

- [X] T015 [P] [US2] Новый сквозной тест `tests/e2e/hidden.e2e.mjs`, quickstart.md §2, строки 7–9.
  - **Скрытие через API.** `PUT …/mark { mark: 'hide' }` → дома нет в `/listings`, `total` на 1 меньше;
    `GET /api/marks?kind=hide` — дом есть; `{ mark: null }` возвращает его в список.
  - **Скрытие кнопкой.** `hd:<id>` под уведомлением → «Скрыто — больше не покажу», клавиатура «Скрыто · вернуть» /
    `uh:<id>`; `uh:<id>` → «Возвращено», клавиатура без отметки.
  - **Скрыто до отправки.** Уведомление ждёт отправки, пользователь скрыл дом → `sendMessage` нет,
    `notifications.status = 'failed'`, `last_error = 'скрыто пользователем'`.
  - **Взаимоисключение.** Лайк → `hd` → `lk`: в каждый момент одна отметка.
  - **Чужие отметки.** Скрытие у `OWNER` не меняет список `MEMBER` с тем же домом.

### Implementation for User Story 2

- [X] T016 [US2] `src/db/listings.js` `searchListings`: условие `(m.kind IS NULL OR m.kind <> 'hide')` в `WHERE` —
  скрытые не входят ни в `rows`, ни в `total` (FR-009, research.md R4).
- [X] T017 [US2] `src/jobs/deliver.js`: строка с `mark = 'hide'` → `resultStatement` `failed`, `last_error` «скрыто
  пользователем», без `sendMessage` (research.md R4).
- [X] T018 [US2] `src/telegram/webhook.js`: `hd:<id>` и `uh:<id>` по contracts/telegram-bot.md 003. `uh` снимает
  только `hide`: если отметка другая, ничего не меняется, клавиатура — по текущей.
- [X] T019 [US2] `src/app/app.js.txt`, по contracts/miniapp-api.md 003:
  - **«Не интересно» на карточке.** После ответа карточка сменяется `ds-card` с `ds-row ds-row--between` («Скрыто»,
    «Вернуть»); «Вернуть» — `PUT { mark: null }` и карточка обратно.
  - **Экран `#/hidden?page=n`.** Кнопки «♡ Нравится», «Вернуть», «Открыть объявление»; «Назад» → `#/liked`.
  - **Ссылка** «Скрытые» на экране «Понравившиеся».
- [X] T020 [US2] `npm test` и `npm run test:e2e` — зелёные.

**Checkpoint**: скрытые не видны в списках и сообщениях, возвращаются — US2 проверяется сама по себе

---

## Phase 5: User Story 3 — Знать, что понравившийся дом снят с продажи (Priority: P2)

**Goal**: раз в сутки страница понравившегося объявления realt и moyareklama без выдачи за сутки; пометки «Снято с
сайта <дата>» и «Не удалось проверить…»

**Independent Test**: страница понравившегося объявления на имитации сайта отвечает 404 → после проверки на карточке
«Снято с сайта <дата>» (spec.md US3)

### Tests for User Story 3 ⚠️

- [X] T021 [P] [US3] Сохранённые страницы и тесты разбора.
  - **`tests/fixtures/realt/card.html`** — живое объявление со страницы, полученной 2026-11-23. Из `__NEXT_DATA__`
    убрать имена, телефоны, e-mail, текст объявления, лишние картинки; оставить `pageProps.object` с ценой, валютой,
    площадями, `status`, `archive`.
  - **`tests/fixtures/realt/card-archived.html`** — та же страница с `archive: 1`.
  - **`tests/sources/realt.test.mjs`**: `parseCard` — цена `{ amount, currency }`, `priceCurrency`, площади;
    `archive` → `{ gone: true }`; HTML без `__NEXT_DATA__` → `null`; `cardRequest(listing)` → `listing.url`;
    `cardSample` открыт в `tests/fixtures/robots/realt.txt`.
  - **`tests/sources/moyareklama.test.mjs`**: `parseCard` на `tests/fixtures/moyareklama/card.html` — 7 000 BYN,
    `priceCurrency: 'BYN'`, площади дома 36,1 м² и участка 25 сот.; страница выдачи → `null`.
  - **`tests/unit/security.test.mjs`** зелёный на новых страницах.
- [X] T022 [P] [US3] `tests/unit/listing-card.test.mjs` — `siteStatus` по data-model.md listings, «Пометка на
  карточке»:
  - `gone_at` → `{ kind: 'gone', at }`;
  - лайк и `MAX(last_seen_at, check_ok_at)` старше 7 суток → `unchecked` с `lastSeenAt`;
  - без лайка или со свежим `check_ok_at` → `null`.
- [X] T023 [P] [US3] Новый сквозной тест `tests/e2e/card-check.e2e.mjs`, quickstart.md §2, строки 10–15. Стенд:
  `h.sites` для `realt.by`, страница объявления по `listings.url`.
  - **Страница на месте.** Лайк на доме realt; сутки дома нет в выдаче; страница 200 → одна проверка, `check_ok_at`;
    к `realt.by` ≤ 1 запроса в минуту.
  - **404** → `siteStatus.kind = 'gone'`; дом в понравившихся.
  - **Возврат в выдачу** → `gone_at` пуст.
  - **403** → не «снято», `sources.state = 'blocked'`, одно сообщение владельцу.
  - **kufar.** Лайк на доме kufar, 8 суток без выдачи → `unchecked`, страниц `re.kufar.by` не запрашивалось.
  - **Два лайка на одном доме** → одна проверка в сутки.
  - **Был в выдаче за сутки** → страница не запрашивается (FR-012, уточнение).
  - **Нечего проверять** → `cards_next_at` через час: «кого проверять» не повторяется каждый тик.

### Implementation for User Story 3

- [X] T024 [P] [US3] `src/sources/realt.js` — `cardRequest`, `cardSample`, `parseCard` по contracts/source-adapter.md
  003. Разбор — `readNextData` → `pageProps.object`, цена и площади — функциями выдачи (`readPrice`, `positive`);
  `archive` истинно → `{ gone: true }`.
- [X] T025 [P] [US3] `src/sources/moyareklama.js` — `cardRequest` (как `detailRequest`), `cardSample`, `parseCard`:
  цена — `<div class="price">` через `parsePrice`, площади — `<title>` через `parseTitle`; контакты не читаются.
- [X] T026 [US3] `src/db/listings.js`:
  - `dueCardStatement(db, source, now)` — запрос data-model.md listings, «Кого проверять»;
  - `cardResultStatement(db, id, fields)`;
  - `existingStatement` — плюс `gone_at`.
- [X] T027 [US3] `src/jobs/poll-feeds.js` — работа `card` по research.md R7 и contracts/source-adapter.md 003 «Ошибки
  проверки страницы».
  - **Когда.** У адаптера есть `cardRequest`; `src.state` не `blocked`/`disallowed`; `cards_next_at ≤ now`
    (data-model.md `sources.cards_next_at`); нет работы `detail` → `dueCardStatement`.
    - Нашлась — работа `card` (`cost` адаптера) впереди ленты.
    - Нет — `cards_next_at = now + CARD_IDLE_MS`.
  - **`doCard`.**
    - Ответы — по таблице contracts/source-adapter.md 003: 200 / `gone` / 404 / 410 / защита / прочее.
    - Поля — data-model.md `listings.checked_at`, `listings.check_ok_at`, `listings.gone_at`.
    - На месте — цена и площади через `normalizeListing` полей карточки.
    - `cards_next_at = now + CARD_GAP_MS`.
  - **`urlsToCheck`** — плюс `cardSample`.
- [X] T028 [US3] `src/jobs/ingest.js` `changedFields`: `old.gone_at !== null` → `gone_at = null` (data-model.md
  `listings.gone_at`, US3-3).
- [X] T029 [US3] `src/match/format.js` `listingCard`: `siteStatus` по data-model.md listings, «Пометка на карточке» —
  нужны `mark` и `now`. `src/http/api.js` передаёт `now` во всех списках.
- [X] T030 [US3] `src/app/app.js.txt`, по contracts/miniapp-api.md 003 «Пометки»:
  - `gone` — `ds-chip ds-chip--warning` «Снято с сайта dd.mm», дата по Минску;
  - `unchecked` — `ds-hint` «Не удалось проверить; в выдаче сайта последний раз dd.mm».
- [X] T031 [US3] `scripts/bench.mjs`: случаи `parseCard` — `realt/card.html` (`cost` 2) и `moyareklama/card.html`
  (`cost` 1); `npm run bench` — медиана ≤ `cost`.
- [X] T032 [US3] `npm test`, `npm run test:e2e`, `npm run bench` — зелёные.

**Checkpoint**: понравившиеся проверяются по страницам, пометки видны — US3 проверяется сама по себе

---

## Phase 6: User Story 4 — Узнавать, что у понравившегося поменялась цена (Priority: P2)

**Goal**: цена в валюте продавца; изменение ≥ 1 % у понравившегося — одно сообщение каждому, у кого лайк

**Independent Test**: лайк на доме за 52 000 $; на имитации сайта цена 48 000 $ → одно сообщение «Цена изменилась:
было 52 000 $, стало 48 000 $ (−4 000 $)» с кнопками (spec.md US4)

### Tests for User Story 4 ⚠️

- [X] T033 [P] [US4] Новый `tests/unit/price-change.test.mjs` — `priceChange(old, next)` по research.md R9, случаи
  quickstart.md §1 «Изменение цены»:
  - граница 1 % — 0,99 % нет, 1 % да;
  - валюты `USD`, `BYN`, `EUR`;
  - неизвестная валюта: обе цены в одну сторону — да; в разные — нет;
  - одна цена — изменение по ней;
  - цена появилась или пропала — нет;
  - продавец сменил валюту — сравнение по долларам и рублям.

  Результат — `{ currency, oldPrice, newPrice } | null`.
- [X] T034 [P] [US4] Валюта продавца в тестах адаптеров и нормализации:
  - `tests/sources/{kufar,realt,domovita,moyareklama}.test.mjs` — `priceCurrency` у каждого объявления сохранённых
    страниц по таблице contracts/source-adapter.md 003 (kufar `EUR` → `null`);
  - `tests/unit/normalize.test.mjs` — `price_amount`/`price_currency` (data-model.md `listings.price_amount`,
    `listings.price_currency`), без валюты — оба `null`.
- [X] T035 [P] [US4] `tests/unit/format.test.mjs` — `priceAlertMessage` по contracts/telegram-bot.md 003 «Сообщение
  об изменении цены»:
  - первая строка с `<b>` и разницей «−4 000 $» (U+2212), «+» при росте;
  - `BYN` и `€`;
  - вторая строка без `<b>`;
  - последняя — «realt.by · в понравившихся»;
  - клавиатура «лайк».
- [X] T036 [P] [US4] Новый сквозной тест `tests/e2e/price-alerts.e2e.mjs`, quickstart.md §2, строки 16–20.
  - **Цена в выдаче** 52 000 → 48 000 $ у дома kufar с `currency: 'USD'`, лайк у `OWNER` и `MEMBER` → каждому одно
    сообщение с кнопками; тот же круг повторно — новых нет.
  - **Курс.** Цена в $, рубли −2 % → сообщений нет.
  - **Цена со страницы** при суточной проверке realt → одно сообщение.
  - **Лайк снят до отправки** → `price_alerts.status = 'cancelled'`, `sendMessage` нет.
  - **Цена стала «договорной»** → сообщения нет.
  - **Без лайка** изменение цены не создаёт строк `price_alerts`.

### Implementation for User Story 4

- [X] T037 [P] [US4] `src/match/price-change.js` — `priceChange(old, next)` по research.md R9 с `PRICE_CHANGE_MIN`.
  `old` и `next` — поля `price_amount`, `price_currency`, `price_usd`, `price_byn`.
- [X] T038 [P] [US4] Адаптеры — `priceCurrency` по contracts/source-adapter.md 003 «RawListing: валюта продавца»:
  - `src/sources/kufar.js` — `ad.currency`: `BYR` → `BYN` с суммой `price_byn`, `USD` → `USD`, прочее → `null`;
  - `src/sources/realt.js` — `readPrice`: валюта, если `price` и `priceCurrency` есть;
  - `src/sources/moyareklama.js` — `BYN`;
  - `src/sources/domovita.js` — `null`.

  `src/sources/normalize.js` `normalizeListing` — `price_amount`, `price_currency` (data-model.md
  `listings.price_amount`, `listings.price_currency`; значение вне `CHECK` → `null`).
- [X] T039 [US4] `src/db/listings.js` — `price_amount`, `price_currency` в `LISTING_COLUMNS` и `existingStatement`.
  Новый `src/db/price-alerts.js`:
  - `insertForLikesStatement(db, listingId, change, now)` — `INSERT … SELECT … FROM marks WHERE kind = 'like' AND
    listing_id = ?` (data-model.md price_alerts, «Правила»);
  - `markStuckStatement`, `duePendingStatement` — с `LEFT JOIN marks` и `users`;
  - `claimStatement`, `resultStatement` — по образцу `src/db/notifications.js`.
- [X] T040 [US4] `src/jobs/ingest.js` `changedFields`:
  - `price_amount`/`price_currency` обновляются вместе с ценой;
  - `priceChange(old, merged)` → `insertForLikesStatement` в тот же `writes` (research.md R10).
- [X] T041 [US4] `src/jobs/poll-feeds.js` `doCard`: при новой цене — `priceChange` и `insertForLikesStatement` в тех
  же `statements`, что запись объявления.
- [X] T042 [US4] `src/match/format.js` — `priceAlertMessage(row, change)` по contracts/telegram-bot.md 003.
  - Вторая строка — общая с `notificationMessage`: вынести первую строку уведомления в функцию, цена — с `<b>` или без.
  - Превью — как у уведомления.
- [X] T043 [US4] `src/jobs/deliver.js` — вторая очередь после уведомлений, из оставшейся доли `allowance`:
  - `price_alerts`: `markStuck`, `due`, `claim`;
  - отметка не `like` → `cancelled`; пользователь без доступа → `undeliverable`;
  - остальное — общая обработка ответа Telegram (вынести из цикла уведомлений в функцию: `sent`, 429, 403, 400,
    повторы; data-model.md `price_alerts.status`, «Переходы»).
- [X] T044 [US4] `src/jobs/daily.js` `cleanupStep` — `DELETE FROM price_alerts WHERE created_at < now -
  PRICE_ALERT_TTL_MS`.
- [X] T045 [US4] `npm test` и `npm run test:e2e` — зелёные.

**Checkpoint**: изменение цены понравившегося приходит одним сообщением, курс не даёт ложных — US4 проверяется сама
по себе

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: лимиты, документация, проверка и выкат

- [X] T046 [P] `tests/e2e/budget.e2e.mjs` — сутки тиков, 30 понравившихся realt и moyareklama без выдачи (SC-007,
  quickstart.md §2, последняя строка):
  - подзапросов на тик ≤ 45, к сайту ≤ 1 запроса в минуту;
  - страница каждого понравившегося — не больше раза в сутки, страницы — не чаще раза в 3 мин на сайт;
  - круги лент по-прежнему проходят.
- [X] T047 [P] `README.md`, раздел «Как пользоваться»:
  - понравившиеся — кнопки, экран, кнопка меню, лимит 100;
  - «Не интересно» и «Скрытые»;
  - пометки «снято» и «не удалось проверить», какие сайты проверяются;
  - сообщения об изменении цены;
  - миграция 0004 в шагах выката (Конституция, «Процесс разработки»).
- [X] T048 [P] Документы 001: в `specs/001-house-listing-alerts/data-model.md` к `listings` (очистка) и
  `notifications` (скрытые → `failed`) — ссылки на data-model.md 003, как сделано для 002.
- [X] T049 `npm test`, `npm run test:e2e`, `npm run bench` — зелёные. `CLAUDE.md`, таблица «Фичи»: строка 003 —
  реализация готова.
- [ ] T050 Выкат по команде владельца «реализуй, деплой» (2026-11-23) — quickstart.md §4:
  1. слияние `003-listing-likes` в `main`;
  2. `npx wrangler d1 migrations apply house-hunter --remote` (0004);
  3. `npx wrangler deploy`.

  Затем: `node scripts/setup-telegram.mjs` не требуется, кнопка меню чата не меняется. Проверка на живом боте:
  - главное меню — «Понравившиеся»;
  - `wrangler tail` — тики без ошибок, работа `card` после суток лайков.

  Итоги — в quickstart.md §5 и строку фичи в `CLAUDE.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup** (Phase 1) — сразу.
- **Foundational** (Phase 2) — после Setup; блокирует все истории.
- **US1** (Phase 3) — после Foundational. Её T011 (`mark` в списке поиска) — основа для T016 (US2).
- **US2** (Phase 4) — после Foundational; T016 правит тот же запрос, что T011, поэтому — после T011.
- **US3** (Phase 5) — после Foundational: лайки для проверки страниц есть в `marks` и без экранов US1. Тест T023
  ставит лайк через API, поэтому нужен T010.
- **US4** (Phase 6) — после Foundational; T041 — после T027 (US3, `doCard`).
- **Polish** (Phase 7) — после выбранных историй; T050 — последним.

### Within Each User Story

- Тесты истории пишутся первыми и падают до реализации.
- Адаптеры и чистые функции → `src/db/*` → шаги тика и API → мини-приложение.
- Задачи `src/app/app.js.txt` (T013, T019, T030) — только по порядку.
- `src/jobs/deliver.js` (T008, T017, T043), `src/telegram/webhook.js` (T009, T018) и `src/db/listings.js` (T011, T016,
  T026, T039) — каждый файл по порядку задач.

### Parallel Opportunities

- Foundational: T003, T005, T006 — вместе; T004 — после T003.
- US1: T007 — вместе с реализацией других файлов.
- US3: T021, T022, T023 — вместе; T024, T025 — вместе после T021.
- US4: T033–T036 — вместе; T037, T038 — вместе после тестов.
- Polish: T046, T047, T048 — вместе.

---

## Parallel Example: User Story 3

```text
# Тесты — вместе:
Task: "T021 tests/fixtures/realt/card*.html + tests/sources/{realt,moyareklama}.test.mjs — parseCard"
Task: "T022 tests/unit/listing-card.test.mjs — siteStatus"
Task: "T023 tests/e2e/card-check.e2e.mjs — проверка страниц"

# Адаптеры — вместе, после тестов:
Task: "T024 src/sources/realt.js — cardRequest/parseCard"
Task: "T025 src/sources/moyareklama.js — cardRequest/parseCard"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1: Setup.
2. Phase 2: Foundational (миграция 0004, отметки, клавиатуры).
3. Phase 3: US1 — лайки и «Понравившиеся».
4. **Стоп и проверка**: `npm test`, `npm run test:e2e`.

### Incremental Delivery

1. Setup + Foundational → схема и отметки.
2. US1 → лайки (MVP).
3. US2 → «Не интересно» и «Скрытые».
4. US3 → проверка страниц и пометки.
5. US4 → сообщения об изменении цены.
6. Polish → лимиты, README, выкат.

Выкат — целиком после Polish, по команде владельца «реализуй, деплой» (2026-11-23). Порядок: сначала миграция, потом
код (quickstart.md §4). Коммит после реализации — только при зелёном `npm test` (CLAUDE.md).

---

## Notes

- [P] — разные файлы и нет зависимости от незаконченных задач.
- Новые запросы к сайтам — только страницы понравившихся по принципу I в редакции 1.3.0. Для kufar.by и domovita.by
  страниц нет (research.md R6).
- Отметки видит только сам пользователь: `user_id` — из `initData` или `callback_query.from` (FR-007).
- Любой интерфейс — только `ds-*`; текст с сайтов — через `textContent`, в сообщениях — экранирование.
- Влить ветку в `main` — по команде владельца: «реализуй, деплой» (2026-11-23) её даёт для этой фичи.
