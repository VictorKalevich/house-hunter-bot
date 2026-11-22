# CLAUDE.md — house-hunter-bot

Telegram-бот, который собирает объявления о продаже домов с участками с kufar.by, realt.by, domovita.by и
moyareklama.by и присылает уведомление о новом объявлении, подходящем под критерии пользователя: цена, площадь
дома, площадь участка, расстояние от населённого пункта. Пользуются владелец и приглашённые им люди.
Cloudflare Worker (бесплатный тариф) + D1 + Cron Triggers. Язык интерфейса и документации — русский.

## Обязательный процесс: Spec Kit

- Любое изменение поведения — через Spec Kit: `/speckit-specify` → (`/speckit-clarify`) → `/speckit-plan` →
  `/speckit-tasks` → `/speckit-implement`. Скилы лежат в `.claude/skills/speckit-*`.
- Спецификации — источник истины: `specs/NNN-имя/`. Активная фича записана в `.specify/feature.json`.
- Конституция: `.specify/memory/constitution.md` — проверяй каждый план по всем принципам.
- Скрипты Spec Kit — PowerShell (`.specify/scripts/powershell/`), платформа разработчика — Windows.

### Как настроен Spec Kit (решение владельца 2026-11-22: «сам настрой»)

- Хуки (`.specify/extensions.yml`, `auto_execute_hooks: true`) выполняются без вопросов владельцу: перед
  `/speckit-specify` — ветка `NNN-имя` (`speckit-git-feature`); после каждого шага — constitution, specify, clarify,
  plan, tasks, implement, checklist, analyze — коммит `/speckit-git-commit` с событием `after_<шаг>`. Коммитов перед
  шагами нет (`before_*` выключены), синхронизации с GitHub Issues нет.
- Сообщение коммита пишет агент (`commit_style: conventional` в `.specify/extensions/git/git-config.yml`):
  `тип(NNN): что сделано` по-русски — `docs(001): план уведомлений о домах`, `feat(001): разбор объявлений kufar.by`.
  Типы: `docs` — spec, plan, tasks, чек-листы; `feat`, `fix`, `test`, `refactor`, `chore` — код и настройка. Тело —
  по желанию, последней строкой после пустой — `Co-Authored-By` из системных указаний. Сообщение — файлом в
  scratchpad (через Write, не через echo), в скрипт — `-MessageFile <путь>`.
- Коммит после `implement` — только при зелёном `npm test`; красный — сначала починить.
- После каждого шага обнови строку фичи в таблице «Фичи» ниже — в том же коммите.
- Влить ветку фичи в `main` — только по команде владельца.
- Скрипты git-расширения (`.specify/extensions/git/scripts/powershell/`) читают файлы с `-Encoding UTF8`: Windows
  PowerShell 5.1 без этого портит русские сообщения коммитов. При обновлении Spec Kit сохрани эту правку.

## Интерфейс: только дизайн-система (правило владельца, 2026-11-22)

- При создании любого интерфейса в этом проекте (мини-приложение, страницы, витрины) всегда используй дизайн-систему
  `design-system/`: токены `tokens.css` и компоненты `ds-*` из `components.css`. Конституция, принцип VII.
- В коде интерфейса — никакого своего CSS, `style=`, классов вне `ds-*`, «сырых» цветов и px.
- Не хватает элемента — сначала добавь его в дизайн-систему: токен → компонент → `preview.html` → таблица в
  `design-system/README.md`, потом используй.
- Проверка — `npm test` (`tests/design-system.test.mjs`). Витрина `design-system/preview.html` открывается в
  браузере прямо из папки; после изменений проверь её в светлой и тёмной колонке.

## Документация библиотек: Context7

- Прежде чем писать или менять код, который использует внешнюю библиотеку, CLI или API (Cloudflare Workers,
  D1, Wrangler, Cron Triggers, Telegram Bot API, сервисы геокодирования и маршрутов и т. п.), получи актуальную
  документацию через MCP-сервер `context7` (`resolve-library-id` → `query-docs`). По памяти не пиши.
- Сервер подключён в `.mcp.json` (HTTP, `https://mcp.context7.com/mcp`, без ключа). Ключ `CONTEXT7_API_KEY`
  нужен только для более высоких лимитов запросов.

## Фичи

| Ветка | Спецификация | Статус |
|---|---|---|
| `001-house-listing-alerts` | `specs/001-house-listing-alerts/` | спецификация готова, дальше `/speckit-plan` |
