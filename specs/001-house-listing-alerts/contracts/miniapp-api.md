# Контракт: HTTP API мини-приложения

Мини-приложение Telegram (`GET /app`) обращается к Worker'у по JSON API на том же домене. Модель полей —
[data-model.md](../data-model.md).

## Общее

- Базовый путь: `/api`. Тело запросов и ответов — `application/json; charset=utf-8`.
- Авторизация: заголовок `Authorization: tma <initData>`, где `initData` — строка `Telegram.WebApp.initData`.
  Сервер проверяет подпись по правилам Telegram (HMAC-SHA256: ключ `HMAC_SHA256("WebAppData", BOT_TOKEN)`,
  строка проверки — пары `key=value` без `hash`, по алфавиту, через `\n`) и свежесть `auth_date` (≤ 24 ч).
- Пользователь берётся только из проверенного `initData.user.id`; id пользователя из тела и адреса не
  принимается. Доступ — у `users.access = active` (или владельца).
- Ошибки — `{"error": {"code": "<код>", "message": "<текст для человека по-русски>"}}`:

| HTTP | `code` | Когда |
|---|---|---|
| 401 | `unauthorized` | Нет или неверная подпись, просрочен `auth_date` |
| 403 | `no_access` | Пользователь без приглашения или доступ закрыт |
| 404 | `not_found` | Поиска нет или он чужой (чужой — тоже 404) |
| 422 | `invalid` | Неверные условия; `fields: {"<поле>": "<что не так>"}` |
| 500 | `internal` | Прочее; подробности только в логах |

## Объекты

```jsonc
// Settlement
{ "id": 1234, "name": "Боровляны", "kind": "village", "district": "Минский район", "region": "Минская область" }

// Criteria — условия поиска (вход и выход); null = не задано
{
  "settlementId": 1234,            // обязателен, если задан maxKm
  "distanceMode": "road_exit",     // "straight" | "road_center" | "road_exit"
  "maxKm": 30,                     // 1…300 или null
  "priceUsd":  { "min": null, "max": 80000 },
  "houseM2":   { "min": 80,   "max": null },
  "plotSotki": { "min": 10,   "max": null },
  "sources": ["kufar", "realt", "domovita", "moyareklama"]   // не пустой; по умолчанию все
}

// Search
{ "id": 7, "title": "Боровляны · до 30 км по дороге от выезда", "status": "active",
  "criteria": { /* Criteria */ }, "settlement": { /* Settlement */ }, "createdAt": "2026-11-22T10:00:00Z" }

// ListingCard — карточка для ds-listing
{
  "source": "kufar", "url": "https://re.kufar.by/vi/…", "photoUrl": "https://…" ,  // photoUrl может быть null
  "priceUsd": 75000, "priceByn": null,                                              // null → «не указано»
  "houseM2": 100, "plotSotki": 15,
  "distance": { "km": 25.4, "mode": "straight", "approx": false, "fallback": false, "pending": false },
  "place": "д. Боровляны, Минский р-н",
  "publishedAt": "2026-11-22T09:41:00Z"
}
```

`distance`: `approx` — место по центру пункта («≈»); `fallback` — дорожный маршрут построить не удалось, показано
по прямой; `pending` — дорожное расстояние ещё считается, показано по прямой. Без ограничения расстояния в поиске
`distance` = null.

## Методы

| Метод и путь | Вход | Ответ | Требования |
|---|---|---|---|
| `GET /api/me` | — | `{ "firstName": "…", "isOwner": false }` | |
| `GET /api/settlements?q=<текст>` | `q` ≥ 2 символов | `{ "items": [Settlement] }` — не больше 10, крупные выше | FR-007 |
| `GET /api/searches` | — | `{ "items": [Search] }` — свои, новые сверху | FR-010 |
| `POST /api/searches` | `Criteria` | `201 Search` (status `active`, `active_since` = сейчас) | FR-006, FR-009, US1 |
| `GET /api/searches/{id}` | — | `Search` | |
| `PUT /api/searches/{id}` | `Criteria` | `Search` | FR-010, FR-017 |
| `POST /api/searches/{id}/pause` | — | `Search` (status `paused`) | US4 |
| `POST /api/searches/{id}/resume` | — | `Search` (status `active`, `active_since` = сейчас) | US4, сценарий 1 |
| `DELETE /api/searches/{id}` | — | `204` | US4, сценарий 3 |
| `GET /api/searches/{id}/listings?page=<n>` | `n` ≥ 1 | `{ "items": [ListingCard], "page": 1, "pageSize": 5, "total": 37 }` | FR-016, US2 |

Правила проверки `Criteria` (ответ 422 с `fields`):

- `maxKm` задан → `settlementId` обязателен и существует.
- Каждая пара `min`/`max`: числа ≥ 0, `min ≤ max`; `maxKm` в 1…300.
- `distanceMode` — одно из трёх значений; `sources` — непустое подмножество четырёх.

Список объявлений (`/listings`):

- Подходящие сейчас, без условия «после создания поиска»; объявления, которые бот видел за последние 30 дней.
- Сортировка по `sort_at` — от новых к старым, по 5 на странице (FR-016).
- Пустой результат — `total: 0`; мини-приложение показывает `ds-empty` с кнопкой «Изменить условия» (US2,
  сценарий 2).

## Страница мини-приложения

| Путь | Ответ |
|---|---|
| `GET /app` | HTML мини-приложения: `src/app/index.html`, на место `/*@design-system*/` подставлены `design-system/tokens.css` и `components.css`; `Cache-Control: no-cache` |
| `GET /app/app.js` | Скрипт мини-приложения, `text/javascript` |

Экраны (только компоненты `ds-*`, принцип VII):

| Экран | Адрес (hash) | Компоненты |
|---|---|---|
| Мои поиски | `#/` | `ds-hero`, `ds-list`/`ds-list-item--link`, `ds-chip--success`/`--warning`, `ds-btn--block`, `ds-empty` |
| Новый / изменить поиск | `#/search/new`, `#/search/{id}` | `ds-field`, `ds-suggest`, `ds-options`, `ds-affix`, `ds-range`, `ds-switch`, `ds-btn`, `ds-btn--danger`, `ds-toast` |
| Объявления поиска | `#/search/{id}/listings?page=n` | `ds-listing`, `ds-fact`, `ds-chips`, `ds-pager`, `ds-empty`, `ds-spinner` |

Кнопка «Сохранить» — основная кнопка Telegram (`MainButton`) или `ds-btn--block`; «Назад» — `BackButton`
Telegram.
