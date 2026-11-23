# Bug Fix: 423 Locked от domovita.by не считается защитой от ботов

- **Slug**: domovita-423-blocked
- **Fixed**: 2026-11-23
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Ответ 423 Locked теперь считается отказом защиты от ботов наравне с 403 и 429. Источник сразу становится `blocked`:
одно сообщение владельцу, следующая проверка через час, дальше по `BLOCKED_BACKOFF_HOURS`. Раньше на 423 бот
обращался к сайту каждую минуту и слал сообщения о сбое и восстановлении, когда случайный запрос проходил.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `src/jobs/poll-feeds.js` | modified | `blockedResponse()`: 423 среди кодов защиты; действует для страниц лент и карточек |
| `specs/001-house-listing-alerts/contracts/source-adapter.md` | modified | таблица классификации: «403, 423, 429 … → `blocked`» |
| `tests/e2e/source-health.e2e.mjs` | added test | 423 без маркеров в теле → `blocked`, сообщение, пауза час |

## Diff Highlights (optional)

```js
// src/jobs/poll-feeds.js, blockedResponse()
if (res.status === 403 || res.status === 423 || res.status === 429) return true;
```

## Tests Added or Updated

- `tests/e2e/source-health.e2e.mjs` — «423 Locked без признаков защиты в теле — тоже отказ защиты: сообщение сразу,
  проверка через час»: ответ 423 с телом `Locked` → `state = blocked`, `error_text = '423, страница защиты от ботов'`,
  `next_check_at` через час; владельцу ровно одно сообщение «отказал боту … следующая проверка через 1 ч»; 55 минут
  запросов к сайту нет, через час — ровно один; затем «Проверить сейчас» и 200 возвращают `ok` для следующих тестов.
  До исправления тест падал: `actual: 'failing', expected: 'blocked'`.

## Local Verification

- Commands run: `node --test tests/e2e/source-health.e2e.mjs` до исправления → новый тест падает (`failing` вместо
  `blocked`), после → 7 из 7; `npm test` → 195 из 195; `npm run test:e2e` → 61 из 61.
- Manual checks: на живом боте — после выката, в `/speckit-bug-test`.

## Deviations from Assessment

Нет.

## Follow-ups

- Выкатить (`npx wrangler deploy` из `main`) и проверить на живом боте: domovita — `blocked`, запросы к ней раз в час и
  реже, у владельца одно сообщение «отказал боту».
- Наблюдать мигание при частичном пропуске (Open Questions в assessment.md): если пары «отказал»/«снова работает»
  будут мешать — решение владельца о гистерезисе отдельной задачей.
