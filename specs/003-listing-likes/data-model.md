# Модель данных: изменения фичи 003

**Фича**: `003-listing-likes` | **База**: [data-model.md 001](../001-house-listing-alerts/data-model.md) и
[002](../002-search-ux-improvements/data-model.md) | **План**: [plan.md](plan.md)

Миграция `migrations/0004_marks.sql`:

- две новые таблицы — `marks` и `price_alerts`;
- колонки в `listings` и `sources` — через `ALTER TABLE … ADD COLUMN`, без перезаписи строк.

Остальная модель — как в 001 и 002. Решения — [research.md](research.md).

## marks — отметка пользователя (новая)

| Поле | Тип | Правила |
|---|---|---|
| `user_id` | INTEGER NOT NULL | → `users (telegram_id)` |
| `listing_id` | INTEGER NOT NULL | → `listings (id)` `ON DELETE CASCADE` |
| `kind` | TEXT NOT NULL | `like` \| `hide` (`CHECK`) |
| `created_at` | INTEGER NOT NULL | Когда поставлена отметка этого вида; порядок экранов «Понравившиеся» и «Скрытые» |

Ключ и индексы:

| Что | Где используется |
|---|---|
| `PRIMARY KEY (user_id, listing_id)`, `WITHOUT ROWID` | Одна отметка на пару: лайк и «Не интересно» исключают друг друга (FR-010) |
| `marks_user (user_id, kind, created_at)` | Экраны «Понравившиеся» и «Скрытые», число лайков для лимита |
| `marks_kind (kind, listing_id)` | Кого проверять (R7), очистка (R5), кому сообщить о цене (R10) |

Правила:

| Действие | Что происходит |
|---|---|
| Поставить лайк | Upsert `kind = 'like'`. Отказ, если у пользователя уже 100 лайков на других объявлениях (FR-006) |
| Скрыть | Upsert `kind = 'hide'`, без лимита. Лайк при этом снимается (FR-010) |
| Снять лайк | `DELETE … AND kind = 'like'` |
| Вернуть | `DELETE … AND kind = 'hide'` |

- `created_at` меняется только при смене вида; повторное то же действие строку не трогает (R2).
- Отметки видит и меняет только сам пользователь: каждый запрос — с `user_id` из проверенного `initData` или
  `callback_query.from` (FR-007).
- **Закрыли доступ** — отметки остаются, сообщения о цене не уходят (`undeliverable`, как у уведомлений). Вернули
  доступ — всё на месте (Assumptions spec).
- **Удаление отметок**:
  - удалить поиск — отметки не трогаются (FR-002);
  - объявление удалено очисткой — отметки удаляются каскадом; с лайком объявление не удаляется (R5).

## listings — объявление: цена продавца и проверка страницы

| Поле | Тип | Правила |
|---|---|---|
| `price_amount` | REAL NULL | Цена в валюте продавца, `> 0`; `NULL` — неизвестна или записана до фичи |
| `price_currency` | TEXT NULL | `USD` \| `BYN` \| `EUR` (`CHECK`); `NULL` — сайт не сообщает валюту продавца |
| `checked_at` | INTEGER NULL | Последняя попытка открыть страницу объявления — при любом исходе |
| `check_ok_at` | INTEGER NULL | Страница последний раз показала, что объявление на месте |
| `gone_at` | INTEGER NULL | Проверка увидела, что объявление снято; `NULL` — не снято |

Индексов не добавляется. Кого проверять, ищется от `marks_kind` (лайки — сотни строк), а не по `listings`.

**Откуда берутся `price_amount` и `price_currency`.** Нормализация берёт их из `RawListing.priceCurrency` и суммы в
этой валюте (contracts/source-adapter.md 003):

| Сайт | `price_currency` | `price_amount` |
|---|---|---|
| realt.by | валюта продавца | `price` |
| kufar.by | `BYR` → `BYN`, `USD` → `USD` | `price_byn` / `price_usd` |
| kufar.by, цена в `EUR` | `NULL` | `NULL` |
| moyareklama.by | `BYN` | цена в рублях |
| domovita.by | `NULL` | `NULL` |

**Обновление при появлении в выдаче** (`ingest`, `changedFields`):

- Колонки цены обновляются вместе с ценой. Если цена поменялась по `priceChange` (R9), в тот же `batch` идёт вставка
  `price_alerts`.
- Старые строки получают `price_amount` при первом появлении в выдаче; если цена при этом поменялась, сравнение — по
  `price_usd` и `price_byn`.
- Объявление снова в выдаче → `gone_at = NULL` (US3-3).

**Проверка страницы** (`poll-feeds`, вид работы `card`):

| Ответ | Что пишется |
|---|---|
| `200`, объявление на месте | `checked_at`, `check_ok_at` = сейчас, `gone_at = NULL`; цена и площади, если поменялись (+ `price_alerts`, как в выдаче) |
| `404`, `410` или страница «снято» | `checked_at` = сейчас, `gone_at = COALESCE(gone_at, сейчас)` |
| Отказ защиты | `checked_at` = сейчас; источник — `blocked`, как у ленты |
| Сбой, тайм-аут, неразобранная страница | Только `checked_at` |

**`last_seen_at`** по-прежнему означает «в выдаче сайта». Проверка страницы его не трогает: пометка «в выдаче сайта
последний раз <дата>» и правило 30 дней опираются на него.

**Кого проверять** — работа `card` для сайта `S` (запрос — `src/db/listings.js`):

```sql
SELECT l.id, l.source, l.external_id, l.url, l.price_amount, l.price_currency, l.price_usd, l.price_byn,
       l.house_m2, l.plot_sotki, l.gone_at
FROM marks m JOIN listings l ON l.id = m.listing_id
WHERE m.kind = 'like' AND l.source = :S
  AND COALESCE(l.checked_at, 0) < :now - 24 ч
  AND l.last_seen_at < :now - 24 ч
GROUP BY l.id
ORDER BY COALESCE(l.checked_at, 0)
LIMIT 1
```

**Пометка на карточке** (`ListingCard.siteStatus`, contracts/miniapp-api.md 003) считается при чтении:

| Условие | `siteStatus` |
|---|---|
| `gone_at` не `NULL` | `gone` |
| Иначе, если у объявления лайк этого пользователя и `MAX(last_seen_at, COALESCE(check_ok_at, 0)) < сейчас − 7 суток` | `unchecked` |
| Иначе | нет пометки |

**Очистка** (суточная) — R5:

```sql
DELETE FROM listings
WHERE last_seen_at < :now - 30 суток
  AND NOT EXISTS (SELECT 1 FROM marks m WHERE m.kind = 'like' AND m.listing_id = listings.id)
```

## sources — источник: очередь проверок страниц

| Поле | Тип | Правила |
|---|---|---|
| `cards_next_at` | INTEGER NULL | Не раньше этого времени искать, какую страницу объявления проверить; `NULL` — сразу |

- **После проверки страницы** — `сейчас + 3 мин`: страницы занимают не больше трети запросов к сайту (R7).
- **Если проверять нечего** — `сейчас + 1 ч`.
- **У адаптера нет `cardRequest`** (kufar.by, domovita.by) — колонка не используется.
- **Источник `blocked` или `disallowed`** — страницы не проверяются, колонка не меняется.

## price_alerts — сообщение об изменении цены (новая)

| Поле | Тип | Правила |
|---|---|---|
| `id` | INTEGER PK | |
| `user_id` | INTEGER NOT NULL | → `users (telegram_id)` |
| `listing_id` | INTEGER NOT NULL | → `listings (id)` `ON DELETE CASCADE` |
| `currency` | TEXT NOT NULL | `USD` \| `BYN` \| `EUR` — валюта сравнения (R9) |
| `old_price` | REAL NOT NULL | `> 0` |
| `new_price` | REAL NOT NULL | `> 0`, `<> old_price` |
| `status` | TEXT NOT NULL DEFAULT `'pending'` | `pending` \| `sending` \| `sent` \| `failed` \| `undeliverable` \| `uncertain` \| `cancelled` |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | |
| `next_attempt_at` | INTEGER NOT NULL DEFAULT 0 | Как у `notifications`: время следующей попытки, у `sending` — время захвата |
| `last_error` | TEXT NULL | |
| `created_at` | INTEGER NOT NULL | |
| `sent_at` | INTEGER NULL | |

Индексы: `price_alerts_queue (status, next_attempt_at)`, `price_alerts_created (created_at)`.

### Переходы

Как у `notifications` (data-model.md 001):

- `pending → sending` — захват.
- Из `sending`:
  - `sent`;
  - `pending` — повтор через 1, 5, 15, 60 мин;
  - `failed` — после 10 попыток или при `400`;
  - `undeliverable` — `403` или пользователь без доступа;
  - `uncertain` — `sending` дольше 10 мин.

Дополнительно — `pending → cancelled` при отправке, если лайка у пользователя больше нет: снят или объявление
скрыто (FR-017).

### Правила

- **Создаётся** только вставкой `INSERT … SELECT … FROM marks WHERE kind = 'like' AND listing_id = ?` — по одной на
  каждого, у кого объявление в понравившихся (US4-3). Вставка идёт в одном `batch` с `UPDATE listings`, который
  записывает новую цену.
- **Без дублей**. Повтор той же выдачи или проверки видит новую цену уже записанной и ничего не вставляет (FR-017).
  Отдельного `UNIQUE` нет: одно и то же объявление может менять цену много раз, и о каждом изменении — своё сообщение.
- **Очистка** — суточная: старше 365 дней, как уведомления.

## Лимиты D1 — добавка к оценке 001

| Что | Записи в сутки | Чтения в сутки |
|---|---|---|
| Отметки (единицы пользователей, десятки нажатий) | ≈ 3 на нажатие → сотни | — |
| Проверка страниц (сотни понравившихся) | ≤ 2 на проверку (объявление + источник) → ≲ 1 000 | «кого проверять» ≤ 480 раз на сайт × сотни строк индекса |
| `cards_next_at` без работы | ≤ 24 на сайт | — |
| Сообщения о цене | 1 на пользователя и изменение + отправка (2) → десятки | — |
| `price_amount` у старых строк | ≤ 1 на объявление, один раз | — |
| Список поиска | — | + поиск по ключу `marks` на строку (≤ 3 000 на запрос) |

Итого запас на фоне ≈ 35 тыс. записей в сутки после разогрева (quickstart 001 §7) — меньше 3 тыс. записей.
