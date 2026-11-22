# Implementation Plan: Тип объекта, понятный итог поиска и сайты в поиске

**Branch**: `002-search-ux-improvements` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-search-ux-improvements/spec.md`

## Summary

Улучшения поверх 001 без новых запросов к сайтам и внешним сервисам. Тип объекта, который адаптеры уже распознают,
сохраняется в `listings.kind`: он показывается первым словом уведомления и меткой карточки, а поиск фильтрует по
трём группам (`searches.kinds`). Мини-приложение получает экран итога поиска (`#/search/{id}`): условия, «сейчас
подходит N», обещание уведомлений, действия и копирование. Форма закрывает две ловушки: пункт без расстояния
отклоняется, о поиске без условий бот предупреждает. В списке объявлений — метка «Новое» и «обновлено …», в пустом
списке первых получаса — «ещё собирает». Состояние сайтов (`GET /api/sources`) видят все пользователи: правило
«сбой подтверждён» общее с сообщением владельцу. Решения — [research.md](research.md), модель —
[data-model.md](data-model.md), интерфейсы — [contracts/](contracts/), проверка — [quickstart.md](quickstart.md).

```text
адаптер.kind ──▶ normalize ──▶ ingest: INSERT … kind / UPDATE kind (если поменялся или был NULL)
                                   │
match / список ◀── passesFilters: сайт, kinds (NULL проходит), цена, площади ──▶ уведомление «Дача · 45 000 $ · …»
мини-приложение: #/ (строка сайтов) → #/search/{id} итог → /edit, /listings, new?copy={id}
GET /api/sources ◀── sources + feeds: down (общее правило с poll-feeds) | collecting | ok
```

## Technical Context

**Language/Version**: как в 001 — JavaScript (ES-модули, JSDoc), без сборки; Node.js 24 для разработки и тестов;
Cloudflare Workers

**Primary Dependencies**: новых нет; devDependencies `wrangler` 4.x, `miniflare` 4.x. Telegram Mini Apps —
`Telegram.WebApp.showPopup` (Bot API 6.2+, запасной `window.confirm`)

**Storage**: Cloudflare D1; миграция `migrations/0002_kinds.sql` — `listings.kind`, `searches.kinds`
(`ALTER TABLE … ADD COLUMN`, без перезаписи строк)

**Testing**: `node:test` — `npm test` (адаптеры, условия, проверка условий, тексты, карточка, состояние сайтов,
дизайн-система) и `npm run test:e2e` (Miniflare, новые сценарии — quickstart.md §2)

**Target Platform**: Cloudflare Workers Free + D1 + Cron Triggers; Telegram на iOS, Android и компьютере

**Project Type**: веб-сервис (Telegram-бот) + мини-приложение Telegram без сборки — как в 001

**Performance Goals**: итог поиска на экране ≤ 3 с после «Сохранить» (SC-004): три запроса к API параллельно, каждый
≤ 1 с; CPU тика не растёт заметно — одно поле в нормализации и одно сравнение в отборе

**Constraints**: ≤ 10 мс CPU и ≤ 50 подзапросов на вызов; D1 — ≤ 100 тыс. записей и ≤ 5 млн чтений в сутки; ни одного
нового запроса к сайтам (FR-020); только `ds-*` в интерфейсе

**Scale/Scope**: те же пользователи и объявления, что в 001; 2 колонки, 1 новый метод API, 1 новый экран и 2 новых
адреса формы, ~15 файлов кода и тестов

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Конституция 1.2.0. Проверено до исследования и повторно после проектирования (data-model, contracts, quickstart).

| Принцип | Как выполняется | Итог |
|---|---|---|
| I. Бережно к сайтам (NON-NEGOTIABLE) | Новых запросов к сайтам нет: тип уже приходит в выдаче, которую бот читает (FR-020). Хранится один новый признак — тип, он нужен фильтру и уведомлению, что принцип разрешает. Контакты, тексты, фото не добавляются | ✅ |
| II. Ни одного дубля, ни одного пропуска | Уникальность объявлений и уведомлений не меняется; копия поиска — обычный поиск, объявление под несколько поисков — одно сообщение (001). Объявления без типа не отсекаются, поэтому до дозаполнения ничего не теряется | ✅ |
| III. Спецификация до кода | Ветка `002-search-ux-improvements`, `specs/002-…`; уточнения 001 (FR-006, FR-014, FR-016) записаны в spec.md 002; уточнения при планировании (тип в карточке — первая метка, «не меньше N») внесены в spec.md этой же ветки | ✅ |
| IV. Бесплатно и без своего сервера | Новых сервисов нет. D1: миграция без перезаписи, дозаполнение `kind` ≤ одной записи на старое объявление; `GET /api/sources` — две маленькие таблицы; итог — тот же запрос, что первая страница списка (data-model.md «Лимиты D1») | ✅ |
| V. Проверено до выката | Юнит-тесты: группа типа, `NULL` проходит, проверка условий, тексты, карточка, правило «сбой подтверждён»; адаптеры — тип у каждого объявления сохранённых страниц; сквозной тест — фильтр по типу, дозаполнение, 422, состояние сайтов, флаги списка | ✅ |
| VI. Просто для пользователя | Всё по-русски, формой и кнопками; тип — первым словом уведомления; итог объясняет, чего ждать; ловушки формы закрыты | ✅ |
| VII. Только дизайн-система (NON-NEGOTIABLE) | Новых компонентов не нужно: `ds-chip--brand` уже заведён для «Новое», переключатели, строки списка с подписью, карточки, подсказки и кнопки есть; `tests/design-system.test.mjs` проверяет `src/app/` | ✅ |
| Безопасность и данные | `GET /api/sources` — с той же проверкой `initData` и доступа; пользователям — только состояние и время, без `error_text`; текст с сайтов — через `textContent`, в сообщениях — экранирование | ✅ |
| Процесс разработки | Context7 — D1 и мини-приложения Telegram (research.md); в tasks.md — задача на README (раздел «Как пользоваться»: типы, итог, копирование, состояние сайтов); `npm test` перед коммитом, `npm run test:e2e` перед слиянием и выкатом | ✅ |

Нарушений нет — Complexity Tracking пуст.

## Project Structure

### Documentation (this feature)

```text
specs/002-search-ux-improvements/
├── spec.md              # спецификация (+ уточнения при планировании)
├── plan.md              # этот файл
├── research.md          # Phase 0: тип, группы, ловушки, итог, копия, метки, состояние сайтов, миграция
├── data-model.md        # Phase 1: listings.kind, searches.kinds, состояние сайтов для пользователей
├── quickstart.md        # Phase 1: тесты, выкат, проверка в Telegram
├── contracts/
│   ├── miniapp-api.md   # изменения Criteria, ListingCard, списка; GET /api/sources; экраны и тексты
│   └── telegram-bot.md  # первая строка уведомления
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

Меняются файлы проекта 001 (структура — [plan.md 001](../001-house-listing-alerts/plan.md)):

```text
migrations/
└── 0002_kinds.sql              # новое: listings.kind, searches.kinds
src/
├── config.js                   # KIND_GROUPS (группа → типы), подписи типов
├── sources/normalize.js        # kind из RawListing
├── jobs/ingest.js              # INSERT kind; changedFields: kind
├── jobs/poll-feeds.js          # «сообщить владельцу» — через общее правило сбоя
├── db/listings.js              # колонка kind; фильтр kinds в списке; totalApprox, distancesPending
├── db/searches.js              # kinds в INSERT/UPDATE и searchToApi
├── db/sources.js               # isConfirmedFailure, sourcesStatus (sources + feeds)
├── db/notifications.js         # l.kind в выборке для отправки
├── match/criteria.js           # kindAllowed в passesFilters
├── match/validate.js           # kinds; пункт без расстояния; «по дороге от центра»
├── match/format.js             # тип в уведомлении; kind, isNew, createdAt в ListingCard
├── http/api.js                 # GET /api/sources; флаги списка
└── app/app.js.txt              # итог, адреса /edit и ?copy, типы, подписи сайтов, ловушки формы, метки, строка сайтов
tests/
├── unit/                       # criteria, validate (новый), format, listing-card, sources-status (новый), normalize
├── sources/*.test.mjs          # тип у каждого объявления
└── e2e/                        # kinds.e2e.mjs, sources-status.e2e.mjs (новые); listings, manage, distance — новые случаи
README.md                       # «Как пользоваться»: типы, итог, копирование, состояние сайтов
```

**Structure Decision**: структура 001 не меняется; новые файлы — миграция `0002_kinds.sql`, два юнит-теста
(`tests/unit/validate.test.mjs`, `tests/unit/sources-status.test.mjs`) и два сквозных сценария
(`tests/e2e/kinds.e2e.mjs` — тип, фильтр, дозаполнение; `tests/e2e/sources-status.e2e.mjs` — состояние сайтов);
модулей кода не прибавляется. Правило «сбой подтверждён» живёт в `src/db/sources.js` рядом с остальной логикой
состояний источника, чтобы `poll-feeds` и API брали его из одного места.

## Complexity Tracking

Нарушений Конституции нет.
