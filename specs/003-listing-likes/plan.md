# Implementation Plan: Понравившиеся, «Не интересно» и изменение цены

**Branch**: `003-listing-likes` | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-listing-likes/spec.md`

## Summary

У каждого пользователя появляются свои отметки объявлений — «нравится» и «не интересно». Хранятся в таблице `marks`,
одна строка на пару «пользователь + объявление», поэтому отметки исключают друг друга.

**Где ставятся отметки**:

- кнопки под уведомлением (`callback_data` `lk`/`ul`/`hd`/`uh`) перерисовываются `editMessageReplyMarkup`;
- кнопки на карточках мини-приложения (`PUT /api/listings/{id}/mark`).

**Где видны и как действуют**:

- экраны «Понравившиеся» и «Скрытые» (`GET /api/marks`); в главное меню бота добавляется кнопка «Понравившиеся»;
- скрытые не попадают в списки поисков и не уходят сообщениями;
- понравившиеся не удаляет суточная очистка.

**Суточная проверка страниц**. Бот раз в сутки открывает страницу понравившегося объявления, которого не было в
выдаче, — у realt.by и moyareklama.by. Это ещё один вид работы сайта в тике, в общем порядке «один запрос в минуту»,
не чаще раза в 3 минуты на сайт. Бот отмечает «снято» (`gone_at`) и обновляет цену.

**Цена в валюте продавца**. Цена хранится в валюте продавца (`price_amount`, `price_currency`), поэтому колебания курса
не дают ложных сообщений. Изменение цены понравившегося — в выдаче или на странице — ставит в очередь `price_alerts`
тем же `batch`, что записывает новую цену. Отправка — шагом `deliver`, по правилам уведомлений 001.

**Поправка к конституции** 1.3.0 — принцип I и «Безопасность и данные».

Решения — [research.md](research.md), модель — [data-model.md](data-model.md), интерфейсы — [contracts/](contracts/),
проверка — [quickstart.md](quickstart.md).

```text
Telegram: кнопка lk/ul/hd/uh ──▶ webhook ──▶ marks (upsert/delete, лимит 100) ──▶ answerCallbackQuery + editMessageReplyMarkup
мини-приложение: ♡ / Не интересно ──▶ PUT /api/listings/{id}/mark ──┘     GET /api/marks?kind= ──▶ #/liked, #/hidden
список поиска: LEFT JOIN marks (без hide) ──▶ карточки с mark и siteStatus

тик: deliver (уведомления, затем price_alerts; hide/без лайка — не слать)
     poll: robots → detail → card (лайк, сутки без выдачи, cards_next_at) → feed
           card: 200 → check_ok_at, цена/площади ─┐   404/archive → gone_at   403 → blocked
     ingest: changedFields (+price_amount, gone_at = NULL) ─┴─▶ priceChange ≥ 1 % ─▶ INSERT price_alerts SELECT … FROM marks (тот же batch)
сутки: cleanup — listings без лайка старше 30 дней; price_alerts старше года
```

## Technical Context

**Language/Version**: как в 001 — JavaScript (ES-модули, JSDoc), без сборки. Node.js 24 — для разработки и тестов,
код работает в Cloudflare Workers.

**Primary Dependencies**: новых нет; devDependencies — `wrangler` 4.x, `miniflare` 4.x. Telegram Bot API:

- `editMessageReplyMarkup`;
- `answerCallbackQuery` с `show_alert`;
- `callback_data` ≤ 64 байт.

Проверено по официальной странице Bot API 10.5 (research.md, вступление).

**Storage**: Cloudflare D1. Миграция `migrations/0004_marks.sql`:

- таблицы `marks` и `price_alerts`;
- колонки `listings.price_amount`, `price_currency`, `checked_at`, `check_ok_at`, `gone_at`;
- колонка `sources.cards_next_at`.

Всё через `ALTER TABLE … ADD COLUMN`, без перезаписи строк.

**Testing**: `node:test`.

- `npm test`:
  - `priceChange`;
  - адаптеры — `priceCurrency` и страницы объявлений на сохранённых страницах;
  - тексты и клавиатуры;
  - карточка;
  - обезличенность;
  - дизайн-система.
- `npm run test:e2e` — Miniflare, сценарии quickstart.md §2.
- `npm run bench` — `parseCard`.

**Target Platform**: Cloudflare Workers Free + D1 + Cron Triggers; Telegram на iOS, Android и компьютере.

**Project Type**: веб-сервис (Telegram-бот) + мини-приложение Telegram без сборки — как в 001.

**Performance Goals**:

| Что | Цель | Как достигается |
|---|---|---|
| Нажатие кнопки до отклика | ≤ 2 с (SC-001) | 4 подзапроса, `answerCallbackQuery` до перерисовки |
| Экран «Понравившиеся» | ≤ 3 с (SC-002) | один `batch` D1 |
| Пометка «снято» | ≤ 26 ч (SC-004) | ≤ 480 страниц в сутки на сайт |
| Сообщение о цене | ≤ 30 мин для объявлений в выдаче (SC-005) | круг ленты 15–30 мин + следующий тик |

**Constraints**: принцип IV:

- ≤ 10 мс CPU и ≤ 50 подзапросов на вызов;
- D1 — ≤ 100 тыс. записей и ≤ 5 млн чтений в сутки.

Принцип I в редакции 1.3.0:

- страница объявления — не чаще раза в сутки и только у понравившихся без выдачи за сутки;
- к сайту — ≤ 1 запроса в минуту вместе с лентами.

Интерфейс — только `ds-*`.

**Scale/Scope**: единицы пользователей, ≤ 100 лайков у каждого, сотни понравившихся на сайт.

- 2 таблицы, 6 колонок, 3 метода API, 2 экрана, 4 вида кнопок;
- 1 новый вид работы тика, 1 новая очередь отправки;
- ~25 файлов кода и тестов.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Конституция 1.2.0; поправка 1.3.0 (research.md R13) вносится `/speckit-constitution` в этой ветке до кода. Проверено
до исследования и повторно после проектирования (data-model, contracts, quickstart).

### I. Бережно к сайтам (NON-NEGOTIABLE)

- **До поправки** — ❌: принцип I разрешает читать только первые страницы выдачи.
- **После поправки 1.3.0** — ✅.

Как выполняется:

- Страница объявления открывается раз в сутки и только у понравившихся, которых не было в выдаче за сутки (R7).
- Запросы — в общем порядке запросов к сайту: `claimSite`, пауза ≥ 1 мин, не чаще раза в 3 мин.
- Адрес страницы сверяется с `robots.txt`. Отказ защиты → `blocked`, без обхода.
- Со страницы читаются только цена и площади. Контакты, текст и фото не сохраняются.
- kufar.by и domovita.by без проверки страниц (R6): по правилам принципа их сейчас не проверить.

### II. Ни одного дубля, ни одного пропуска

Итог: ✅.

- Отметка — одна строка на пару, действия кнопок явные (R2).
- Сообщение о цене создаётся в одном `batch` с новой ценой: повтор обработки его не дублирует. Не ушло — уходит по
  правилам уведомлений 001.
- Скрытые и снятые лайки отсекаются при отправке.
- Сбой страницы одного сайта не трогает остальные.

### III. Спецификация до кода

Итог: ✅.

- Ветка `003-listing-likes`, папка `specs/003-…`.
- Уточнения при планировании внесены в spec.md этой ветки:
  - страница не открывается, если объявление было в выдаче за сутки;
  - kufar.by и domovita.by без проверки страниц.
- Поправка конституции — до кода.

### IV. Бесплатно и без своего сервера

Итог: ✅.

- Новых сервисов нет.
- Подзапросы: страница — 3, нажатие — 4.
- CPU страницы ≤ 2 единиц `bench` вместо ленты, а не сверх неё.
- Записи D1 — ≲ 3 тыс. в сутки сверх ≈ 35 тыс. (data-model.md «Лимиты D1»).

### V. Проверено до выката

Итог: ✅.

- Разбор страниц realt и moyareklama — на сохранённых, обезличенных страницах.
- `priceCurrency` — на всех страницах выдачи.
- Правило цены — юнит-тесты на границах 1 % и при колебаниях курса.
- Сквозные сценарии отметок, скрытых, проверки страниц, цены и суток тиков (quickstart.md §2).

### VI. Просто для пользователя

Итог: ✅.

- Всё по-русски, кнопками.
- Состояние видно на самой кнопке.
- Кнопка в меню бота и на главном экране.
- Пометки «Снято с сайта 24.11» и «Не удалось проверить…» объясняют, чего ждать.

### VII. Только дизайн-система (NON-NEGOTIABLE)

Итог: ✅. Новых компонентов не нужно (R12): кнопки `ds-btn--sm` и `--secondary`, `ds-row--wrap`, `ds-chip--warning`,
`ds-hint`, `ds-card`, `ds-pager`, `ds-empty`. Проверка — `tests/design-system.test.mjs`.

### Безопасность и данные

- **До поправки** — ❌: отметок пользователя в перечне хранимого нет.
- **После поправки 1.3.0** — ✅.

Как выполняется:

- Отметки — только свои: `user_id` из `initData` или `callback_query.from` (FR-007).
- Текст с сайтов в сообщении о цене экранируется, в мини-приложении — `textContent`.
- `callback_data` несёт только `listings.id`.

### Процесс разработки

Итог: ✅.

- Context7: D1 `batch` как транзакция, записи индексов; Telegram — обзор. Методы Bot API — официальная страница:
  Context7 их не содержит.
- В tasks.md — задача на README («Как пользоваться»: понравившиеся, «Не интересно», цена; конституция 1.3.0).
- `npm test` перед коммитом, `npm run test:e2e` перед слиянием и выкатом.

**Итог гейта**: проходит при поправке 1.3.0, которая вносится первой задачей. Без неё Complexity Tracking держал бы
два постоянных исключения — вместо этого конституция меняется явно.

## Project Structure

### Documentation (this feature)

```text
specs/003-listing-likes/
├── spec.md              # спецификация (+ уточнения при планировании)
├── plan.md              # этот файл
├── research.md          # Phase 0: отметки, кнопки, скрытые, очистка, страницы, расписание, пометки, цена, очередь, экраны, конституция, лимиты
├── data-model.md        # Phase 1: marks, price_alerts, listings (цена продавца, проверка), sources.cards_next_at
├── quickstart.md        # Phase 1: тесты, выкат, проверка в Telegram
├── contracts/
│   ├── miniapp-api.md   # ListingCard (id, mark, siteStatus), GET /api/marks, PUT /api/listings/{id}/mark, экраны
│   ├── telegram-bot.md  # кнопка меню, кнопки под сообщениями, нажатия, сообщение о цене
│   └── source-adapter.md # priceCurrency, cardRequest/parseCard, ошибки проверки страницы
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

Меняются файлы проекта 001/002 (структура — [plan.md 001](../001-house-listing-alerts/plan.md)):

```text
.specify/memory/constitution.md   # 1.3.0: принцип I, «Безопасность и данные»
migrations/
└── 0004_marks.sql                # новое: marks, price_alerts, колонки listings и sources
src/
├── config.js                     # LIKES_MAX, CARD_CHECK_MS, CARD_GAP_MS, CARD_IDLE_MS, UNCHECKED_AFTER_MS, PRICE_CHANGE_MIN
├── db/marks.js                   # новое: setMark, getMark, listMarks, liked-for-check
├── db/price-alerts.js            # новое: очередь сообщений о цене (по образцу notifications.js)
├── db/listings.js                # existingStatement (+price_amount, price_currency, gone_at); searchListings — отметки; dueCard
├── db/notifications.js           # отметка в выборке для отправки
├── match/price-change.js         # новое: priceChange(old, next)
├── match/format.js               # ListingCard (id, mark, siteStatus, distance.from); клавиатуры; текст сообщения о цене
├── sources/normalize.js          # price_amount, price_currency
├── sources/{realt,kufar,moyareklama}.js  # priceCurrency; cardRequest/parseCard (realt, moyareklama)
├── jobs/ingest.js                # changedFields: цена продавца, gone_at; вставка price_alerts
├── jobs/poll-feeds.js            # вид работы card, cards_next_at, cardSample в urlsToCheck
├── jobs/deliver.js               # клавиатура с отметками; скрытые; вторая очередь price_alerts
├── jobs/daily.js                 # очистка: лайки не удаляются; price_alerts старше года
├── telegram/webhook.js           # кнопка меню «Понравившиеся»; lk/ul/hd/uh для всех пользователей
├── telegram/api.js               # editMessageReplyMarkup, answerCallbackQuery с show_alert
├── http/api.js                   # GET /api/marks, PUT /api/listings/{id}/mark
└── app/app.js.txt                # кнопки карточки, «Скрыто · Вернуть», #/liked, #/hidden, пометки, кнопка на главном
tests/
├── unit/                         # price-change (новый), format (тексты, клавиатуры, карточка), normalize, security
├── sources/*.test.mjs            # priceCurrency; parseCard realt и moyareklama
├── fixtures/realt/card*.html     # новые, обезличенные
└── e2e/                          # likes.e2e.mjs, hidden.e2e.mjs, card-check.e2e.mjs, price-alerts.e2e.mjs (новые); budget — сутки с лайками
bench/                            # parseCard realt и moyareklama
README.md                         # «Как пользоваться»: понравившиеся, «Не интересно», сообщения о цене
```

**Structure Decision**: структура 001 не меняется. Новые модули:

- `src/db/marks.js`, `src/db/price-alerts.js` — по одной таблице на модуль, как остальные `src/db/*`;
- `src/match/price-change.js` — чистое правило рядом с `criteria.js`, чтобы `ingest` и проверка страницы брали его из
  одного места.

Проверка страницы — вид работы в `poll-feeds.js` рядом с `detail`: там уже живут `claimSite`, отказ защиты и
`robots.txt`. Отправка сообщений о цене — в `deliver.js`: общий захват, повторы и разбор ответа Telegram выносятся в
функцию, которую используют обе очереди.

## Complexity Tracking

Нарушений конституции в редакции 1.3.0 нет. Поправка 1.3.0 — первая задача фичи (research.md R13).
