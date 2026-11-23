# Quickstart: установка и проверка

**Фича**: `001-house-listing-alerts` | **План**: [plan.md](plan.md)

Как поставить бота и убедиться, что сценарии спецификации работают. Модель — [data-model.md](data-model.md),
интерфейсы — [contracts/](contracts/). Команды — PowerShell на Windows из корня репозитория.

## 1. Что нужно

- Node.js 24 и npm; `npm install` ставит `wrangler` и `miniflare` (devDependencies).
- Аккаунт Cloudflare (бесплатный), вход: `npx wrangler login`.
- Бот от @BotFather: токен и имя бота (`BOT_USERNAME`).
- Свой Telegram ID — владелец (`OWNER_TELEGRAM_ID`), например из @userinfobot.
- Бесплатный ключ openrouteservice: регистрация на account.heigit.org → ключ `ORS_API_KEY` (адрес API —
  `api.heigit.org`).

## 2. Быстрые тесты

```powershell
npm install
npm test            # дизайн-система, адаптеры на сохранённых страницах, фильтры, расстояния, robots.txt, initData
npm run bench       # время разбора каждой сохранённой страницы; ошибка, если медиана дороже cost мс
```

Ожидание: все тесты зелёные; в отчёте `bench` у каждой страницы медиана ≤ её `cost` мс. Пометка «мало запаса»
(медиана выше половины `cost`) — не ошибка: эти ленты сверить по CPU в логах после выката (шаг 6).

## 3. Локальный запуск

1. `.dev.vars` (в `.gitignore`): `BOT_TOKEN`, `WEBHOOK_SECRET` (случайная строка), `OWNER_TELEGRAM_ID`,
   `ORS_API_KEY`; в `wrangler.jsonc` — `BOT_USERNAME`, `PUBLIC_URL`.
2. База и справочник:

   ```powershell
   npx wrangler d1 migrations apply house-hunter --local
   npx wrangler d1 execute house-hunter --local --file seeds/settlements.sql
   ```

3. `npx wrangler dev --test-scheduled`, затем тик вручную:
   `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"`. Ожидание: в логе одна строка тика —
   какие ленты прочитаны, сколько объявлений, сколько новых.

Справочник пересобирается редко и только разработчиком: `node scripts/build-settlements.mjs` (Overpass; при 429/504
повторить позже или передать `--overpass-url`).

## 4. Сквозной тест (перед слиянием и выкатом)

```powershell
npm run test:e2e
```

Miniflare поднимает Worker из исходников с локальной D1, миграциями и маленьким справочником
(`tests/fixtures/settlements-small.sql`); сайты, Telegram, ORS, OSRM и НБ РБ подменены (`tests/e2e/harness.mjs`), время
тиков задаёт стенд. Около полутора минут, из них минута — сутки тиков. Сценарии:

| Сценарий | Ожидание |
|---|---|
| Поиск «до 30 км по прямой от Минска, до 80 000 $, дом от 80 м², участок от 10 сот.»; в ленте одно подходящее новое объявление и одно неподходящее | Ровно одно `sendMessage` подходящему (US1, сценарии 2–3) |
| Тот же тик ещё раз; объявление поднято (тот же номер) | Второго `sendMessage` нет (US1-4, SC-002) |
| Поиск создан, в ленте 50 старых подходящих (не новых на сайте) | Уведомлений нет, в `/api/searches/{id}/listings` они есть (US1-5, US2) |
| Telegram ответил 500, затем 200 | Уведомление ушло в следующем тике один раз (FR-015) |
| Telegram ответил 403 | `undeliverable`, у пользователя `blocked_at`, сбоя нет |
| Сайт 3 раза подряд отдаёт 503 | Владельцу одно сообщение о сбое, остальные сайты работают; после 200 — «снова работает» (US5) |
| Сайт отдаёт страницу защиты (403) | `blocked`, сообщение владельцу, следующий запрос — не раньше чем через час (US5-2) |
| Два поиска одного пользователя, оба подходят; один на паузе | Одно сообщение, в нём только активный поиск (US4) |
| Без приглашения → `/start`; приглашение → вход; повторно та же ссылка с другого аккаунта | Отказ; доступ; отказ (US6) |
| Режим «по дороге от выезда», место внутри границы пункта | Расстояние 0 км (US3-3) |
| Сутки тиков на всех четырёх сайтах | Подзапросов на тик ≤ 45, к сайту ≤ 1 запроса в минуту, лента — не чаще раза в 15 мин, записи D1 — в пределах оценки data-model.md (принципы I и IV) |

## 5. Выкат

```powershell
npx wrangler d1 create house-hunter                      # один раз; id базы — в wrangler.jsonc
npx wrangler d1 migrations apply house-hunter --remote
npx wrangler d1 execute house-hunter --remote --file seeds/settlements.sql
npx wrangler secret put BOT_TOKEN                        # и WEBHOOK_SECRET, OWNER_TELEGRAM_ID, ORS_API_KEY
npx wrangler deploy
node scripts/setup-telegram.mjs --dry-run                # проверить запросы (без отправки, без токена в выводе)
node scripts/setup-telegram.mjs                          # setWebhook с secret_token, команды, кнопка меню
```

Ожидание: `getWebhookInfo` — адрес Worker'а, `pending_update_count` 0, без `last_error_message`.

## 6. Проверка в Telegram после выката

1. **Владелец** (US1, US2): `/start` → «Новый поиск» → в мини-приложении набрать начало названия пункта, выбрать
   из подсказок (район и область видны), способ «по прямой», 30 км, цена до 80 000 $ → «Сохранить». Ожидание: итог
   поиска и сообщение, что новые объявления будут приходить; первый поиск — меньше чем за 3 минуты (SC-003).
2. «Мои поиски» → поиск → «Показать объявления»: по 5 карточек, от новых к старым, «Дальше» и «Назад»; поля без
   данных — «не указано» (US2, FR-016).
3. Переключить способ на «по дороге от выезда»: подписи расстояний в карточках меняются, часть объявлений
   уходит или появляется (US3); пока маршрут считается — «по прямой, считается».
4. **Источники**: кнопка «Источники» — у всех четырёх «работает» и время последней проверки не старше 30 мин. Если
   какой-то сайт сразу `blocked` — сайт не пускает запросы с адресов Cloudflare: обход не делаем, решение за владельцем.
5. **Приглашение** (US6): «Пригласить» → открыть ссылку со второго аккаунта → он заводит поиск; та же ссылка с
   третьего аккаунта — отказ; «Пользователи» → «Закрыть доступ» → второй аккаунт получает «Доступ к боту закрыт».
6. **Наблюдение**: `npx wrangler tail` — строки тиков без `exceededCpu`; панель D1 — чтения и записи в пределах
   оценки data-model.md; первое реальное уведомление приходит ≤ 30 мин после появления объявления (SC-001).

## 7. Ход выката (T088) — где остановились

Состояние на 2026-11-23, 11:30 UTC: бот выкачен из `main` и отвечает в Telegram; осталась проверка вместе с
владельцем (шаг 3 ниже).
Начатую работу продолжать отсюда по порядку: владелец в новой сессии (любой аккаунт Claude, этот компьютер, папка
`C:\ClaudeProjects\house-hunter-bot`) пишет «продолжи T088». Агент сначала проверяет `npx wrangler whoami` — вход
есть, `.dev.vars` на месте и заполнен (без вывода значений). `.dev.vars` и вход Wrangler есть только на этом
компьютере: с другого — `git clone https://github.com/VictorKalevich/house-hunter-bot.git`, заново
`npx wrangler login` и `.dev.vars` от владельца.

**Сделано**

- `npx wrangler whoami` — вход в Cloudflare есть (OAuth, аккаунт владельца).
- `npx wrangler d1 create house-hunter --location eeur` — база создана, `database_id` записан в `wrangler.jsonc`.
- `npx wrangler d1 migrations apply house-hunter --remote` — `0001_init.sql` применена.
- `npx wrangler d1 execute house-hunter --remote --file seeds/settlements.sql` — справочник загружен:
  `SELECT COUNT(*) FROM settlements` = 22 497. Повторно не загружать: это ещё ~90 тыс. записей D1.
- Бот создан в @BotFather: `@HouseHunterRBBot`, имя — в `vars.BOT_USERNAME` в `wrangler.jsonc`.
- `.dev.vars` создан из `.dev.vars.example`, `WEBHOOK_SECRET` сгенерирован (32 случайных байта, base64url).
- Владелец вписал в `.dev.vars` `BOT_TOKEN` (первый токен попал в чат и отозван, вписан новый), `OWNER_TELEGRAM_ID`,
  `ORS_API_KEY`. Проверено без вывода значений: формат всех четырёх, `getMe` отвечает `@HouseHunterRBBot`, ключ ORS
  строит маршрут.
- 2026-11-23, после сброса суточного лимита записей D1 (выкат ждал его: справочник 22 ноября записал 89 988 строк из
  100 000), на `main`: `npm test` (195) и `npm run test:e2e` (60) — зелёные; `npx wrangler d1 migrations apply
  house-hunter --remote` — применена `0002_kinds.sql`.
- `npx wrangler deploy --secrets-file .dev.vars` — Worker выкачен, четыре секрета загружены (`wrangler secret list`);
  адрес `https://house-hunter-bot.cycle-push.workers.dev` — в `vars.PUBLIC_URL`, `npx wrangler deploy` ещё раз,
  секреты сохранились. Дальнейшие выкаты — просто `npx wrangler deploy`.
- `node scripts/setup-telegram.mjs --dry-run`, затем без него: `setWebhook`, `setMyCommands`, `setChatMenuButton` —
  ok; `getWebhookInfo` — адрес Worker'а, ожидают обновлений 0, ошибок нет. `/app` отвечает 200, webhook без секрета —
  401. Владелец нажал `/start` — заведён с ролью `owner`.
- Cron: новые триггеры расходятся по сети Cloudflare до 15 минут (документация Cron Triggers). Первый тик — 11:30 UTC,
  через 7 минут после выката: `robots.txt` всех четырёх сайтов прочитан, все `ok`, заведено 26 лент (kufar 1, realt
  12, domovita 7, moyareklama 6).
- Первые 40 минут (11:30–12:10 UTC), `wrangler tail` и D1:
  - kufar, realt, moyareklama — `ok`, первый круг лент прочитан, ~1 000 объявлений; первые новые на сайтах
    (`fresh`) — с 11:59. Один тайм-аут kufar (15 с) прошёл сам, без сообщения владельцу.
  - domovita отвечает адресам Cloudflare `423 Locked`; пропустила 2 запроса из ~20 (18 объявлений). Бот считал 423
    временным сбоем: запрос каждую минуту и сообщения владельцу «не отвечает» / «снова работает» при каждом пропуске.
    Решение владельца — 423 считать защитой от ботов. Исправлено по процессу bugfix
    (`.specify/bugs/domovita-423-blocked/`), выкачено в 11:56: domovita — `blocked`, проверки через 1, 2, 4, 8, 24 ч,
    обхода нет. С адресов Cloudflare объявлений с domovita практически не будет.
  - Все тики `ok`, `exceededCpu` нет. Но CPU выше оценки плана (≤ 10 мс на вызов): пустой тик 6–14 мс, страница
    ленты без новых объявлений 17–27 мс, разогрев (30 новых объявлений за тик) 20–43 мс; медиана 24 мс. По документации
    Cloudflare изредка превышать лимит можно, постоянное превышение может начать обрываться (`exceededCpu`).
    Наблюдать: `npx wrangler tail --format json` — поле `outcome`; появится `exceededCpu` — разбор по процессу bugfix.
  - Записи D1: разогрев — 160 строк за тик, после него — ~24 строки за тик в среднем (≈ 35 тыс. в сутки из 100 тыс.).
    Сверить завтра: `npx wrangler d1 info house-hunter`, `rows_written_24h`.

**Не сделано**

3. Проверка §6 и [quickstart 002 §5](../002-search-ux-improvements/quickstart.md) вместе с владельцем; итоги — в
   этот раздел; T088 отметить в tasks.md, строку фичи в `CLAUDE.md` обновить; коммит.
