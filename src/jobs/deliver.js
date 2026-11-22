// Шаг тика «отправка»: contracts/telegram-bot.md «Обработка ответа Telegram», data-model.md notifications.
import { CHAT_GAP_MS, RETRY_DELAYS_MS, TICK } from '../config.js';
import { claimStatement, duePendingStatement, markStuckStatement, resultStatement, searchTitlesStatement } from '../db/notifications.js';
import { notificationMessage } from '../match/format.js';
import { sendMessage } from '../telegram/api.js';

const MAX_ATTEMPTS = 10;
/** Подзапросы, которые остаются другим шагам тика. */
const RESERVE_FOR_OTHER_STEPS = 22;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deliverStep(ctx) {
  const { db, env, now, budget } = ctx;
  const allowance = Math.min(TICK.deliverPerTick, budget.subrequestLimit - budget.subrequests - RESERVE_FOR_OTHER_STEPS - 3);
  if (allowance <= 0) return null;

  const [, due] = await db.batch([markStuckStatement(db, now), duePendingStatement(db, now, allowance)]);
  const rows = due.results;
  if (rows.length === 0) return null;

  const searchIds = [...new Set(rows.flatMap((r) => JSON.parse(r.search_ids)))];
  const [claim, titles] = await db.batch([
    claimStatement(db, rows.map((r) => r.id), now),
    searchTitlesStatement(db, searchIds),
  ]);
  if (claim.meta.changes !== rows.length) {
    // Кто-то успел раньше (не должно случаться при аренде тика) — ничего не отправляем, чтобы не было дублей.
    return { skipped: 'claim-conflict' };
  }
  const titleById = new Map(titles.results.map((t) => [t.id, t.title]));

  const writes = [];
  const stats = { sent: 0, retry: 0, failed: 0, undeliverable: 0 };
  const lastSentToChat = new Map();
  let stopped = false;
  for (const row of rows) {
    if (stopped) {
      writes.push(resultStatement(db, row.id, { status: 'pending', next_attempt_at: now }));
      continue;
    }
    if (row.access !== 'active' || row.blocked_at !== null) {
      writes.push(resultStatement(db, row.id, { status: 'undeliverable', last_error: row.access !== 'active' ? 'access revoked' : 'bot blocked' }));
      stats.undeliverable += 1;
      continue;
    }
    const searchTitles = JSON.parse(row.search_ids).map((id) => titleById.get(id)).filter(Boolean);
    if (row.url === null || searchTitles.length === 0) {
      writes.push(resultStatement(db, row.id, { status: 'failed', last_error: row.url === null ? 'listing removed' : 'searches removed' }));
      stats.failed += 1;
      continue;
    }

    const gap = (lastSentToChat.get(row.user_id) ?? 0) + CHAT_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    const message = notificationMessage(row, { searchTitles, distanceLabel: row.distance_label });
    const attempts = row.attempts + 1;
    let res;
    try {
      res = await sendMessage(env, row.user_id, message.text, {
        reply_markup: message.reply_markup,
        link_preview_options: message.link_preview_options,
      });
    } catch (err) {
      res = { ok: false, errorCode: null, description: `сеть: ${String(err?.message ?? err).slice(0, 100)}`, retryAfter: null };
    }
    budget.use(1);
    lastSentToChat.set(row.user_id, Date.now());

    if (res.ok) {
      writes.push(resultStatement(db, row.id, { status: 'sent', attempts, sent_at: now, last_error: null }));
      stats.sent += 1;
    } else if (res.errorCode === 429) {
      const wait = (res.retryAfter ?? 30) * 1000;
      writes.push(resultStatement(db, row.id, { status: 'pending', attempts, next_attempt_at: now + wait, last_error: res.description }));
      stats.retry += 1;
      stopped = true;
    } else if (res.errorCode === 403) {
      writes.push(resultStatement(db, row.id, { status: 'undeliverable', attempts, last_error: res.description }));
      writes.push(db.prepare('UPDATE users SET blocked_at = ? WHERE telegram_id = ?').bind(now, row.user_id));
      stats.undeliverable += 1;
    } else if (res.errorCode === 400) {
      console.error(JSON.stringify({ event: 'deliver_400', notification: row.id, description: res.description }));
      writes.push(resultStatement(db, row.id, { status: 'failed', attempts, last_error: res.description }));
      stats.failed += 1;
    } else if (attempts >= MAX_ATTEMPTS) {
      writes.push(resultStatement(db, row.id, { status: 'failed', attempts, last_error: res.description }));
      stats.failed += 1;
    } else {
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      writes.push(resultStatement(db, row.id, { status: 'pending', attempts, next_attempt_at: now + delay, last_error: res.description }));
      stats.retry += 1;
    }
  }
  if (writes.length) await db.batch(writes);
  return stats;
}
