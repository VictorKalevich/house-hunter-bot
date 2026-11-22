# house-hunter-bot

Telegram-бот, который следит за объявлениями о продаже домов с участками на kufar.by, realt.by, domovita.by и
moyareklama.by и присылает сообщение, как только появляется новый дом под условия пользователя: цена, площадь
дома, площадь участка, расстояние от выбранного населённого пункта — по прямой, по дороге от центра или по дороге от
выезда. Поиски заводятся в мини-приложении Telegram, там же — список подходящих объявлений. Пользуются владелец и
приглашённые им люди.

Работает на бесплатном тарифе Cloudflare: Worker, база D1 и Cron Triggers (тик раз в минуту, суточная задача в
00:30 UTC). Сайты читаются бережно: только адреса, открытые в robots.txt, не чаще одного запроса к сайту в минуту,
честный User-Agent, без обхода защиты.

## Как устроено

| Где | Что |
|---|---|
| `src/index.js` | Вход Worker'а: HTTP (`src/http/router.js`) и cron (`src/jobs/tick.js`, `src/jobs/daily.js`) |
| `src/jobs/` | Шаги тика: отправка уведомлений → опрос лент → сохранение объявлений → отбор → маршруты; суточная задача: курс НБ РБ, чистка, отметки «новое», robots.txt |
| `src/sources/` | Адаптеры сайтов (`contracts/source-adapter.md`), нормализация, разбор robots.txt |
| `src/geo/` | Справочник пунктов, расстояния, границы, клиенты openrouteservice и OSRM |
| `src/telegram/`, `src/http/` | Webhook бота, сообщения владельцу, API и страница мини-приложения |
| `src/app/` | Мини-приложение: только компоненты дизайн-системы `design-system/` |
| `migrations/`, `seeds/` | Схема D1 и справочник населённых пунктов из OpenStreetMap |

Спецификация, план, модель данных и контракты — `specs/001-house-listing-alerts/`.

## Команды

```powershell
npm install
npm test             # быстрые тесты: адаптеры на сохранённых страницах, фильтры, расстояния, тексты, безопасность
npm run test:e2e     # сквозные сценарии в Miniflare с подменой сайтов, Telegram и маршрутов (~1,5 мин)
npm run bench        # время разбора каждой сохранённой страницы против бюджета CPU
npm run dev          # локальный Worker: wrangler dev --test-scheduled
npm run deploy       # wrangler deploy
node scripts/setup-telegram.mjs [--dry-run]                # webhook, команды и кнопка меню бота
node scripts/build-settlements.mjs [--overpass-url URL]    # пересборка seeds/settlements.sql из OpenStreetMap
```

Установка, локальный запуск, выкат и проверка в Telegram — по шагам в
[quickstart.md](specs/001-house-listing-alerts/quickstart.md).

## Секреты

Секреты не хранятся в репозитории. Локально — файл `.dev.vars` (он в `.gitignore`; образец — `.dev.vars.example`), в
Cloudflare — `npx wrangler secret put <ИМЯ>`:

| Имя | Что |
|---|---|
| `BOT_TOKEN` | Токен бота от @BotFather |
| `WEBHOOK_SECRET` | Случайная строка: Telegram присылает её в заголовке `X-Telegram-Bot-Api-Secret-Token` |
| `OWNER_TELEGRAM_ID` | Telegram ID владельца |
| `ORS_API_KEY` | Ключ openrouteservice (account.heigit.org) |

Открытые переменные `BOT_USERNAME` и `PUBLIC_URL` — в `wrangler.jsonc`.

## Как вносить изменения

Любое изменение поведения — через Spec Kit: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
`/speckit-implement`; каждый план сверяется с конституцией `.specify/memory/constitution.md`. Интерфейс — только из
дизайн-системы `design-system/`. Перед слиянием — зелёные `npm test`, `npm run test:e2e` и `npm run bench`.
Подробности — `CLAUDE.md`.

## Данные

Данные карт © участники OpenStreetMap, лицензия ODbL 1.0 (справочник населённых пунктов и границ). Маршруты —
© openrouteservice by HeiGIT; запасной маршрутизатор — FOSSGIS OSRM. Курс USD/BYN — Национальный банк Республики
Беларусь. Объявления принадлежат сайтам-источникам: бот хранит только поля для отбора (цена, площади, место, ссылка,
фото), без имён, телефонов и e-mail продавцов, и удаляет объявления, не виденные 30 дней.
