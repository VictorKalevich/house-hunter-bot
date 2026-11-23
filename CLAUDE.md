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

### Состав Spec Kit (CLI и проект — 1.4.3, всё из официального каталога)

| Что | Команды | Когда |
|---|---|---|
| Ядро | `/speckit-constitution`, `-specify`, `-clarify`, `-plan`, `-tasks`, `-implement`, `-analyze`, `-checklist`, `-converge` | Каждая фича |
| `git` 1.0.8 | `/speckit-git-feature`, `-git-commit`, `-git-initialize`, `-git-validate`, `-git-remote` | Сами, через хуки |
| `agent-context` 1.0.3 | `/speckit-agent-context-update` | Сам после specify и plan, до коммита: обновляет блок `SPECKIT` в конце этого файла (ссылка на текущий план) |
| `assess` 1.0.2 + процесс `assess` | `/speckit-assess-intake` → `-research` → `-define` → `-shape` → `-decide` | Новая идея, о которой не ясно, делать ли: итог «делаем» — в `/speckit-specify`, «нет» — закрыть. Папка `.specify/assessments/<slug>/` |
| `bug` 1.0.2 + процесс `bugfix` | `/speckit-bug-assess` → `-bug-fix` → `-bug-test` | Ошибка в уже сделанном: разбор, исправление, проверка тестом. Папка `.specify/bugs/<slug>/` |
| Процессы | `specify workflow list` — `speckit` (полный цикл), `assess`, `bugfix` | Те же шаги по порядку с остановками на проверку |

- Не поставлено: `github` (задачи в GitHub Issues). Расширения сообщества в каталоге только для просмотра, без
  проверки их не ставим.
- Репозиторий на GitHub — `origin`, https://github.com/VictorKalevich/house-hunter-bot (открытый, создан владельцем
  2026-11-22): всё, что попадает в `main`, видно всем — секреты только в `.dev.vars`, сохранённые страницы
  обезличены (`tests/unit/security.test.mjs`).
- `agent-context` нужен Python с PyYAML: в `.claude/settings.local.json` задан `SPECKIT_PYTHON` — Python самого Spec Kit
  (`%APPDATA%\uv\tools\specify-cli\Scripts\python.exe`).
- Обновление: CLI — `uv tool install specify-cli --force --from git+https://github.com/github/spec-kit.git@vX.Y.Z`
  (`specify self upgrade` на Windows ломает установку: не может заменить сам себя); проект — `specify integration
  upgrade --force`; расширения — `specify extension update` (подтверждение `y` подавать из Git Bash:
  `printf 'y\n' | …`). Обновление расширения сбрасывает хуки в `.specify/extensions.yml` — после него верни настройки
  выше: `before_*` выключены, у `after_*` `optional: false`, `agent-context` — `priority: 5` и в списке раньше `git`.
  Затем `specify integration status` — должен быть OK.
- `.ps1` хранятся с LF (`.gitattributes`): Spec Kit сверяет свои файлы по контрольным суммам версии с LF.

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
| `001-house-listing-alerts` | `specs/001-house-listing-alerts/` | реализация готова: T001–T087, `npm test`, `test:e2e`, `bench` зелёные; влита в `main` 2026-11-22 вместе с 002; идёт T088: 2026-11-23 выкачена из `main` (миграция 0002, секреты, webhook) на `https://house-hunter-bot.cycle-push.workers.dev`, бот `@HouseHunterRBBot` отвечает, три сайта работают, domovita отвечает Cloudflare 423 — исправлено (`.specify/bugs/domovita-423-blocked/`), CPU тика выше оценки плана при `exceededCpu` 0 — наблюдать; осталась проверка в Telegram вместе с владельцем — `quickstart.md` §6 и 002 §5; где остановились — `quickstart.md` §7 |
| `002-search-ux-improvements` | `specs/002-search-ux-improvements/` | реализация готова: T001–T048 (тип объекта, итог поиска, ловушки формы, новое/поднятое, сайты в поиске и копия, состояние сайтов для всех), `npm test` (195), `test:e2e` (60), `bench` зелёные; влита в `main` 2026-11-22, выкачена 2026-11-23 вместе с 001 (`0002_kinds.sql` применена); проверка в Telegram — `quickstart.md` §5 в рамках T088 |
| `003-listing-likes` | `specs/003-listing-likes/` | реализация готова: T001–T049 (`marks` лайк/скрыто, кнопки `lk`/`ul`/`hd`/`uh`, экраны `#/liked`, `#/hidden`, страницы понравившихся realt и moyareklama раз в сутки — у обоих «не найдено» приходит с кодом 200, `price_alerts` в валюте продавца, миграция `0004_marks.sql`), `npm test` (218), `test:e2e` (93), `bench` (17) зелёные; конституция 1.3.0; выкат T050 — по команде владельца «реализуй, деплой» (2026-11-23): слияние в `main`, миграция 0004, `wrangler deploy` |

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/003-listing-likes/plan.md
<!-- SPECKIT END -->
