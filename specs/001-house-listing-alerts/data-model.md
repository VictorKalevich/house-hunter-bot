# Модель данных: уведомления о новых домах с участками

**Фича**: `001-house-listing-alerts` | **Хранилище**: Cloudflare D1 (SQLite) | **План**: [plan.md](plan.md)

Время везде — миллисекунды Unix (UTC), `INTEGER`. Деньги — `REAL` в долларах США (`*_usd`) и белорусских рублях
(`*_byn`). Площадь дома — м², площадь участка — сотки. Схема создаётся миграциями `migrations/NNNN_*.sql`
(`wrangler d1 migrations`), здесь — поля, связи, правила и переходы состояний.

## Сводка

```text
users 1───* searches *───1 settlements 1───0..1 settlement_shapes
users 1───* invites (created_by / used_by)
users 1───* notifications *───1 listings (по паре source + external_id)
sources 1───* feeds (ленты выдачи: регионы и разделы сайта)
sources 1───* listings
settlements 1───* distances *───(geo_key)─── listings
access_denials, rates, locks — служебные
```

## users — пользователь

| Поле | Тип | Правила |
|---|---|---|
| `telegram_id` | INTEGER PK | Telegram ID |
| `first_name` | TEXT NOT NULL | Имя из Telegram, обновляется при каждом обращении |
| `username` | TEXT NULL | @имя, если есть |
| `role` | TEXT NOT NULL | `owner` \| `member`. `owner` — только тот, чей ID равен секрету `OWNER_TELEGRAM_ID` |
| `access` | TEXT NOT NULL | `active` \| `revoked` |
| `invited_by` | INTEGER NULL → users | Кто пригласил (у владельца NULL) |
| `blocked_at` | INTEGER NULL | Когда Telegram ответил «бот заблокирован» (403); очищается, когда пользователь снова пишет боту |
| `created_at`, `revoked_at` | INTEGER | |

- Пользователь с `access = revoked` не получает уведомлений, его поиски не участвуют в отборе (FR-019), на
  сообщения бот отвечает «доступа нет». Поиски не удаляются.
- Пользователь с `blocked_at` пропускается при отправке; это не сбой (крайний случай «заблокировал бота»).

```text
(нет записи) ──вход по приглашению──▶ active ──владелец закрыл доступ──▶ revoked
владелец: запись создаётся при первом /start с ID = OWNER_TELEGRAM_ID, role = owner, access = active
```

## access_denials — отметка об отказе

| Поле | Тип | Правила |
|---|---|---|
| `telegram_id` | INTEGER PK | |
| `first_at`, `last_at` | INTEGER | |
| `attempts` | INTEGER | |

Для человека без приглашения хранится только это — ни имени, ни текста сообщений (US6, сценарий 1).

## invites — приглашение

| Поле | Тип | Правила |
|---|---|---|
| `token` | TEXT PK | 16 случайных байт, base64url (22 символа); ссылка `https://t.me/<бот>?start=inv_<token>` (≤ 64 символов, алфавит `A-Za-z0-9_-`) |
| `created_by` | INTEGER → users | Только владелец |
| `created_at` | INTEGER | |
| `used_by` | INTEGER NULL → users | |
| `used_at` | INTEGER NULL | |

- Одноразовое: вход — `UPDATE invites SET used_by = ?, used_at = ? WHERE token = ? AND used_by IS NULL`; успех
  только при `changes = 1`, поэтому одной ссылкой не войдут двое даже одновременно (FR-019).
- Если по ссылке пришёл уже имеющий доступ пользователь, приглашение не тратится.

## settlements — населённый пункт (справочник)

| Поле | Тип | Правила |
|---|---|---|
| `id` | INTEGER PK | |
| `osm_ref` | TEXT UNIQUE | `n123`/`w123`/`r123` — объект OSM, из которого взят пункт |
| `name` | TEXT NOT NULL | Название по-русски |
| `name_norm` | TEXT NOT NULL | Нижний регистр, `ё → е`, без кавычек и лишних пробелов; индекс — для поиска по началу названия |
| `kind` | TEXT NOT NULL | `city` \| `town` \| `village` \| `hamlet` \| … (тип места OSM) |
| `district` | TEXT NULL | Район («Минский район»); у городов областного подчинения — NULL |
| `region` | TEXT NOT NULL | Область или «Минск» |
| `lat`, `lon` | REAL NOT NULL | Центр |
| `rank` | INTEGER NOT NULL | Порядок в подсказках: города выше деревень, крупные выше мелких |

- Заполняется один раз скриптом `scripts/build-settlements.mjs` из данных OpenStreetMap (ODbL) и сидом в D1;
  пересобирается вручную при необходимости. Бот его не меняет.
- Подсказка (FR-007): `name_norm >= :q AND name_norm < :q || '￿'`, сортировка `rank`, не больше 10 строк;
  в ответе район и область, чтобы различать одноимённые деревни.

## settlement_shapes — граница населённого пункта

| Поле | Тип | Правила |
|---|---|---|
| `settlement_id` | INTEGER PK → settlements | |
| `polygon` | TEXT NOT NULL | Упрощённый внешний контур (encoded polyline, точность 5 знаков) |
| `radius_km` | REAL NOT NULL | Наибольшее расстояние от центра до границы — для грубого отбора «от выезда» |
| `source` | TEXT NOT NULL | `osm` (полигон из OSM) \| `circle` (окружность по типу пункта, если полигона нет) |

Нужна только для способа «по дороге от выезда» (FR-008, US3). Полигоны берутся у городов, посёлков и
агрогородков; у деревень и хуторов (меньше километра в поперечнике) — окружность радиусом по типу пункта
(research.md, R4).

## sources — источник

| Поле | Тип | Правила |
|---|---|---|
| `id` | TEXT PK | `kufar` \| `realt` \| `domovita` \| `moyareklama` |
| `state` | TEXT NOT NULL | `ok` \| `failing` \| `blocked` \| `disallowed` (адрес ленты закрыли в robots.txt) |
| `last_request_at` | INTEGER NULL | Последний запрос к сайту: следующий — не раньше чем через минуту (принцип I) |
| `max_id_seen` | INTEGER NULL | Наибольший номер объявления, который бот видел (для сайтов с растущими номерами) |
| `new_id_floor` | INTEGER NULL | Отметка суточной давности: объявление с номером выше неё — новое на сайте |
| `id_snapshot` | INTEGER NULL | `max_id_seen` на момент прошлой суточной смены отметки |
| `robots_checked_at` | INTEGER NULL | Когда последний раз сверяли адреса лент с robots.txt |
| `consecutive_failures` | INTEGER | Сбои подряд |
| `error_kind` | TEXT NULL | `http` \| `blocked` \| `parse` \| `empty` |
| `error_text` | TEXT NULL | Короткое описание для владельца (без содержимого страниц) |
| `failing_since` | INTEGER NULL | Начало текущего сбоя |
| `alerted_at` | INTEGER NULL | Когда владельцу сообщили о текущем сбое; NULL — не сообщали |
| `backoff_level` | INTEGER | Для `blocked`: проверки через 1, 2, 4, 8, 24 ч |
| `last_ok_at`, `last_checked_at` | INTEGER NULL | |

```text
ok ──сбой (http/parse/empty)──▶ failing ──3 сбоя подряд──▶ failing + одно сообщение владельцу
ok/failing ──403, 429, капча, страница защиты──▶ blocked: снят с обычного опроса, сообщение владельцу,
                                                   редкая проверка (1→2→4→8→24 ч) или «Проверить сейчас»
ok/failing ──адрес ленты закрыт в robots.txt──▶ disallowed: опрос остановлен, сообщение владельцу
failing/blocked ──успешный опрос──▶ ok (+ «снова работает», если владельцу сообщали о сбое)
disallowed ──robots.txt снова разрешает──▶ ok
```

Сбой одного источника не трогает остальные (принцип II). Сообщение о сбое — одно на сбой (FR-020).

Суточная смена отметки (ежедневный cron): `new_id_floor = id_snapshot`, `id_snapshot = max_id_seen`. Так отметка
отстаёт на 24–48 ч: новое объявление получает номер выше неё, а старое поднятое — намного ниже.

## feeds — лента выдачи

Источник читается одной или несколькими лентами: регионы и разделы сайта (принцип I, Конституция 1.2.0).
Список лент задаёт адаптер (`src/sources/<id>.js`), строки создаются при первом запуске.

| Поле | Тип | Правила |
|---|---|---|
| `id` | TEXT PK | `realt:gomel-region:cottages`, `kufar:all`, … |
| `source` | TEXT NOT NULL → sources | |
| `next_poll_at` | INTEGER | Начало следующего круга: при `ok` — через `interval` + случайно 0–5 мин; круг каждой ленты — раз в 15–30 мин (FR-003) |
| `page` | INTEGER | Какую страницу читать следующей (1…`maxPages`) |
| `page_cursor` | TEXT NULL | Курсор следующей страницы, если сайт листает курсором (kufar) |
| `prev_ids` | TEXT NULL | Номера неплатных объявлений прошлого круга (JSON, ≤ 300): если последнее неплатное объявление страницы было в прошлом круге — круг закончен, иначе читается следующая страница |
| `last_ok_at` | INTEGER NULL | |

Ленты одного источника опрашиваются по очереди: к сайту — не больше одного запроса в тик, то есть с паузой ≥ 1 мин.

## listings — объявление

| Поле | Тип | Правила |
|---|---|---|
| `id` | INTEGER PK | |
| `source` | TEXT NOT NULL → sources | |
| `external_id` | TEXT NOT NULL | Номер на сайте; `UNIQUE (source, external_id)` — принцип II |
| `url` | TEXT NOT NULL | Ссылка на объявление (только `https://` на домен источника) |
| `price_usd` | REAL NULL | Цена в $; если на сайте только BYN — пересчёт по курсу НБ РБ на день проверки |
| `price_byn` | REAL NULL | Цена в BYN, если сайт её показывает |
| `house_m2` | REAL NULL | Площадь дома |
| `plot_sotki` | REAL NULL | Площадь участка; га и м² пересчитываются (1 га = 100 сот., 100 м² = 1 сот.) |
| `lat`, `lon` | REAL NULL | Координаты: с сайта или центр найденного населённого пункта |
| `geo_approx` | INTEGER NOT NULL | 1 — место по названию пункта («≈» в карточке), 0 — точные координаты |
| `geo_key` | TEXT NULL | `lat,lon`, округлённые до 4 знаков (~10 м): ключ кеша расстояний |
| `settlement_id` | INTEGER NULL → settlements | Найденный пункт объявления (если удалось) |
| `place_text` | TEXT NOT NULL | Место словами, как на сайте («д. Боровляны, Минский р-н»); экранируется при выводе |
| `photo_url` | TEXT NULL | Одна ссылка на фото |
| `published_at` | INTEGER NULL | Дата публикации или поднятия по данным сайта |
| `site_created_at` | INTEGER NULL | Дата создания объявления, если сайт её даёт (realt — `createdAt`, domovita — `date_reception`) |
| `is_new` | INTEGER NOT NULL | 1 — объявление новое на сайте: бот его раньше не видел, и оно создано ≤ 48 ч назад (`site_created_at`) или его номер выше `sources.new_id_floor` (kufar, moyareklama). 0 — старое, поднятое продавцом |
| `sort_at` | INTEGER NOT NULL | `published_at`, а если его нет — `first_seen_at`; порядок списка «от новых к старым» |
| `first_seen_at` | INTEGER NOT NULL | Когда бот впервые увидел объявление |
| `last_seen_at` | INTEGER NOT NULL | Когда видел в выдаче последний раз; обновляется не чаще раза в сутки, чтобы беречь лимит записей D1 |
| `match_state` | TEXT NOT NULL | `pending` \| `done` — прошёл ли отбор под поиски |
| `match_waiting_since` | INTEGER NULL | С какого времени отбор ждёт дорожных расстояний |

Правила:

- Поле, которое сайт не показал, — NULL; фильтр по нему не отсекает объявление, в карточке — «не указано»
  (крайние случаи спецификации). «Договорная» — NULL.
- Тексты описаний и фото целиком не хранятся (принцип I).
- Повторное появление (поднятие, повтор в выдаче) не создаёт новой записи: обновляются `last_seen_at`, цена и
  площади. Повторного уведомления нет (см. `notifications`).
- Хранится, пока бот видит объявление, и 30 дней после `last_seen_at`; затем удаляется ежедневной чисткой.
- Индексы: `UNIQUE (source, external_id)`; `(match_state)` для `pending`; `(lat)` — отбор по широте для списка;
  `(sort_at)`; `(last_seen_at)` — для чистки.

```text
(нет) ──первый раз в выдаче, is_new = 1──▶ pending ──отбор под все активные поиски──▶ done
(нет) ──первый раз в выдаче, is_new = 0──▶ done (только для списка, без уведомлений)
pending ──нужны дорожные расстояния, ещё не посчитаны──▶ pending (match_waiting_since)
         └─ ждёт дольше 20 мин ──▶ отбор по прямой с пометкой «по прямой» ──▶ done
```

Самый первый опрос источника (отметок ещё нет) только запоминает объявления: все получают `is_new = 0`.

## searches — поиск

| Поле | Тип | Правила |
|---|---|---|
| `id` | INTEGER PK | |
| `user_id` | INTEGER NOT NULL → users | |
| `title` | TEXT NOT NULL | Собирается из условий: «Боровляны · до 30 км по дороге от выезда» |
| `settlement_id` | INTEGER NULL → settlements | Обязателен, если задано `max_km` (FR-006) |
| `distance_mode` | TEXT NOT NULL | `straight` \| `road_center` \| `road_exit` (FR-008) |
| `max_km` | REAL NULL | 1…300 |
| `price_min_usd`, `price_max_usd` | REAL NULL | ≥ 0, `min ≤ max` |
| `house_min_m2`, `house_max_m2` | REAL NULL | ≥ 0, `min ≤ max` |
| `plot_min_sotki`, `plot_max_sotki` | REAL NULL | ≥ 0, `min ≤ max` |
| `sources` | TEXT NOT NULL | Список через запятую, по умолчанию все четыре (FR-009); не пустой |
| `status` | TEXT NOT NULL | `active` \| `paused` |
| `active_since` | INTEGER NOT NULL | Время создания или последнего включения (FR-012) |
| `created_at`, `updated_at` | INTEGER | |

Правила:

- Границы диапазонов включительные: «до 80 000 $» пропускает 80 000 $.
- Объявление подходит, если (1) источник в `sources`; (2) для уведомлений — `is_new = 1` и
  `first_seen_at ≥ active_since` (для списка не нужно); (3) каждое заданное условие выполнено или поле объявления
  не указано; (4) при заданном `max_km` у объявления есть место и расстояние выбранным способом ≤ `max_km`.
- Смена условий меняет список сразу и действует на объявления, отбор которых ещё не прошёл; уже отправленные
  уведомления не отзываются (FR-017). `active_since` при этом не меняется.
- Удаление — строка удаляется; её id убирается из будущих отборов, отправленные уведомления остаются.

```text
(создан) active ──пауза──▶ paused ──включить──▶ active (active_since = сейчас)
active/paused ──удалить──▶ (нет)
```

## distances — кеш расстояний

| Поле | Тип | Правила |
|---|---|---|
| `settlement_id` | INTEGER → settlements | Центр (и граница) пункта поиска |
| `geo_key` | TEXT | Место объявления; `PRIMARY KEY (settlement_id, geo_key)` |
| `straight_km` | REAL NOT NULL | По прямой от центра (гаверсинус) |
| `road_center_km` | REAL NULL | По дороге от центра — длина маршрута |
| `road_exit_km` | REAL NULL | Часть того же маршрута за границей пункта; 0, если место внутри границы |
| `status` | TEXT NOT NULL | `pending` \| `ok` \| `failed` |
| `attempts` | INTEGER | |
| `requested_at`, `computed_at` | INTEGER | |

- Один маршрут даёт оба дорожных расстояния. Пара считается один раз и переиспользуется всеми поисками и
  объявлениями с тем же местом (принцип IV: не запрашивать одно и то же дважды).
- Пара ставится в очередь, только если объявление проходит остальные условия какого-либо поиска, а нижняя
  оценка по прямой (от центра; для «от выезда» — минус `radius_km`) не больше `max_km`: дорога не короче прямой.
- `failed` после 3 попыток или «маршрут не найден» — используется расстояние по прямой с пометкой (крайний
  случай спецификации).

## notifications — уведомление

| Поле | Тип | Правила |
|---|---|---|
| `id` | INTEGER PK | |
| `user_id` | INTEGER NOT NULL → users | |
| `source`, `external_id` | TEXT NOT NULL | Объявление; `UNIQUE (user_id, source, external_id)` — одно сообщение на объявление, даже если запись объявления удалят и оно появится снова |
| `listing_id` | INTEGER NULL → listings | Для сборки сообщения |
| `search_ids` | TEXT NOT NULL | id поисков, под которые подошло (JSON-массив) — FR-013 |
| `distance_label` | TEXT NULL | Готовая подпись расстояния на момент отбора («25 км по прямой», «≈ 31 км по дороге от выезда») |
| `status` | TEXT NOT NULL | `pending` \| `sending` \| `sent` \| `failed` \| `undeliverable` \| `uncertain` |
| `attempts` | INTEGER | |
| `next_attempt_at` | INTEGER | |
| `last_error` | TEXT NULL | |
| `created_at`, `sent_at` | INTEGER | |

- Создаётся `INSERT OR IGNORE` в одном `db.batch()` с переводом объявления в `done`: повторный запуск, двойной
  cron или падение на середине не дают второй записи (принцип II, SC-002).
- Индекс `(status, next_attempt_at)`. Хранится год, потом удаляется.

```text
pending ──взят в отправку (claim)──▶ sending ──200 OK──▶ sent
sending ──ошибка сети / 5xx / 429──▶ pending (next_attempt_at: retry_after или 1, 5, 15, 60 мин) — FR-015
sending ──403 «бот заблокирован»──▶ undeliverable (+ users.blocked_at)
sending ──400 (сообщение неверно)──▶ failed (видно в логах; не повторяется)
sending ──завис > 10 мин (вызов прервали после отправки)──▶ uncertain: не повторяется, чтобы не прислать дубль
pending ──пользователь лишился доступа──▶ undeliverable
```

## rates — курс НБ РБ

| Поле | Тип | Правила |
|---|---|---|
| `date` | TEXT PK | `YYYY-MM-DD` |
| `usd_byn` | REAL NOT NULL | Официальный курс: BYN за 1 USD |
| `fetched_at` | INTEGER | |

Обновляется раз в сутки. Если курса на сегодня ещё нет, берётся последний известный.

## locks — блокировка тика

| Поле | Тип | Правила |
|---|---|---|
| `name` | TEXT PK | `tick` |
| `holder` | TEXT | Случайный id вызова |
| `expires_at` | INTEGER | Аренда на 5 минут |

Захват: `UPDATE locks SET holder = ?, expires_at = ? WHERE name = 'tick' AND expires_at < ?` → `changes = 1`.
Два тика cron одновременно не работают.

## Лимиты D1 (бесплатный тариф) — оценка

| Что | Оценка в сутки | Лимит |
|---|---|---|
| Записи: новые объявления (~1 000 × строка и 4 индекса) | ~5 000 | 100 000 |
| Записи: `last_seen_at` (не чаще раза в сутки на объявление) | ~3 000 | |
| Записи: уведомления, расстояния, источники, ленты (~2 500 страниц), блокировка тика (1 440 тиков) | ~9 000 | |
| Чтения: тики, отбор, списки в мини-приложении (отбор по широте, ≤ 3 000 строк на страницу) | ~1–2 млн | 5 000 000 |
| Размер: справочник пунктов и границ + объявления за 30 дней | десятки МБ | 500 МБ на базу |
