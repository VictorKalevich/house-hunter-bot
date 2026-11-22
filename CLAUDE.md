# CLAUDE.md — house-hunter-bot

Telegram-бот, который собирает объявления о продаже домов с участками с kufar.by, realt.by и domovita.by и
присылает уведомление о новом объявлении, подходящем под критерии пользователя: цена, площадь дома, площадь
участка, расстояние от населённого пункта. Cloudflare Worker (бесплатный тариф) + D1 + Cron Triggers. Язык
интерфейса и документации — русский.

## Обязательный процесс: Spec Kit

- Любое изменение поведения — через Spec Kit: `/speckit-specify` → (`/speckit-clarify`) → `/speckit-plan` →
  `/speckit-tasks` → `/speckit-implement`. Скилы лежат в `.claude/skills/speckit-*`.
- Спецификации — источник истины: `specs/NNN-имя/`. Активная фича записана в `.specify/feature.json`.
- Конституция: `.specify/memory/constitution.md` — проверяй каждый план по всем принципам.
- Скрипты Spec Kit — PowerShell (`.specify/scripts/powershell/`), платформа разработчика — Windows.

## Документация библиотек: Context7

- Прежде чем писать или менять код, который использует внешнюю библиотеку, CLI или API (Cloudflare Workers,
  D1, Wrangler, Cron Triggers, Telegram Bot API, сервисы геокодирования и маршрутов и т. п.), получи актуальную
  документацию через MCP-сервер `context7` (`resolve-library-id` → `query-docs`). По памяти не пиши.
- Сервер подключён в `.mcp.json` (HTTP, `https://mcp.context7.com/mcp`, без ключа). Ключ `CONTEXT7_API_KEY`
  нужен только для более высоких лимитов запросов.

## Фичи

| Ветка | Спецификация | Статус |
|---|---|---|
