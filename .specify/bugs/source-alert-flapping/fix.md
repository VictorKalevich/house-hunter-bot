# Bug Fix: пары сообщений «снова работает» / «отказал боту» при частичном пропуске сайта

- **Slug**: source-alert-flapping
- **Fixed**: 2026-11-23
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Сбой, о котором сообщили владельцу, теперь закрывается только после 3 успешных запросов к сайту подряд. До этого
отказ продолжает тот же сбой: начало сбоя прежнее, новых сообщений нет. Пауза после отказа по-прежнему начинается с
часа, так что kufar и дальше раз в час отдаёт свежие объявления.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `migrations/0003_consecutive_ok.sql` | added | `sources.consecutive_ok INTEGER NOT NULL DEFAULT 0` |
| `src/config.js` | modified | `OKS_TO_RECOVER = 3` |
| `src/jobs/poll-feeds.js` | modified | `onSuccess`: счётчик успехов, «снова работает» и очистка `alerted_at`/`failing_since` — на 3-м успехе подряд; `onFailure`: счётчик успехов в 0 |
| `tests/e2e/source-health.e2e.mjs` | added test, updated 3 tests | новый — частичный пропуск; восстановление в трёх тестах — после 3 успехов |
| `specs/001-house-listing-alerts/data-model.md` | modified | поле `consecutive_ok`, переход «3 успешных опроса подряд» |
| `specs/001-house-listing-alerts/contracts/telegram-bot.md` | modified | правило восстановления в «Сообщениях владельцу о сбоях» |
| `specs/001-house-listing-alerts/quickstart.md` | modified | §4: «после трёх ответов 200 подряд — «снова работает»» |

## Diff Highlights (optional)

```js
// src/jobs/poll-feeds.js, onSuccess()
const oks = src.consecutive_ok + 1;
const fields = { state: 'ok', consecutive_failures: 0, consecutive_ok: oks, /* … */ };
if (src.alerted_at === null) {
  fields.failing_since = null;
} else if (oks >= OKS_TO_RECOVER) {
  await sendOwnerAlert(env, recoveryText(src.id, src.failing_since, now));
  Object.assign(fields, { alerted_at: null, failing_since: null });
}
```

## Tests Added or Updated

- `tests/e2e/source-health.e2e.mjs` — «сайт пропускает один запрос в час и снова отказывает — сбой не закрыт, новых
  сообщений нет»: 403 → `blocked` и одно сообщение; три часа подряд плановая проверка проходит (`ok`), следующий запрос
  снова 403 → `blocked`, `failing_since` — исходный, следующая проверка через час, к сайту по 2 запроса в час; за три
  часа у владельца одно сообщение; затем «Проверить сейчас» и сайт отвечает: после 2 успехов сообщения нет, после 3-го —
  «снова работает. Сбой длился 3 ч …», `alerted_at` и `failing_since` очищены. До исправления падал: `failing_since`
  сдвигался.
- «затем 200 → «снова работает» после 3 успешных запросов подряд» — после 2 успехов сообщения нет, после 3-го есть.
  До исправления падал (сообщение после первого успеха).
- «кнопка «Проверить сейчас»», «423 Locked …» — восстановление после 3 успешных запросов.

## Local Verification

- Commands run: `node --test tests/e2e/source-health.e2e.mjs` до исправления → 4 из 8 падают (два — ошибка, два —
  следом за ней), после → 8 из 8; `npm test` → 195 из 195; `npm run test:e2e` → 62 из 62 (в том числе `budget.e2e`).
- Manual checks: на живом боте — после выката, в `/speckit-bug-test`.

## Deviations from Assessment

Нет.

## Follow-ups

- Выкат по порядку: `npx wrangler d1 migrations apply house-hunter --remote` (`0003`), затем `npx wrangler deploy`.
- На живом боте: kufar после плановой проверки уходит снова в `blocked` без сообщений владельцу, `failing_since`
  прежний; объявления kufar прибавляются раз в час.
