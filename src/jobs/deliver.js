// Шаг тика «отправка»: contracts/telegram-bot.md «Обработка ответа Telegram», data-model.md notifications;
// после уведомлений — сообщения об изменении цены (specs/003-listing-likes/data-model.md price_alerts).
import { CHAT_GAP_MS, RETRY_DELAYS_MS, TICK } from '../config.js';
import { claimStatement, duePendingStatement, markStuckStatement, resultStatement, searchTitlesStatement } from '../db/notifications.js';
import * as priceAlerts from '../db/price-alerts.js';
import { notificationMessage, priceAlertMessage } from '../match/format.js';
import { sendMessage } from '../telegram/api.js';

const MAX_ATTEMPTS = 10;
/** Подзапросы, которые остаются другим шагам тика. */
const RESERVE_FOR_OTHER_STEPS = 22;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Отправка одного сообщения и запись итога через result(id, fields): sent, повтор, 429 (остановка до конца тика),
 * 403 (бот заблокирован), 400, исчерпаны попытки.
 */
async function send(ctx, state, row, message, result) {
  const { db, env, now, budget } = ctx;
  const { writes, stats } = state;
  const gap = (state.lastSentToChat.get(row.user_id) ?? 0) + CHAT_GAP_MS - Date.now();
  if (gap > 0) await sleep(gap);
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
  state.lastSentToChat.set(row.user_id, Date.now());

  if (res.ok) {
    writes.push(result(row.id, { status: 'sent', attempts, sent_at: now, last_error: null }));
    stats.sent += 1;
  } else if (res.errorCode === 429) {
    const wait = (res.retryAfter ?? 30) * 1000;
    writes.push(result(row.id, { status: 'pending', attempts, next_attempt_at: now + wait, last_error: res.description }));
    stats.retry += 1;
    state.stopped = true;
  } else if (res.errorCode === 403) {
    writes.push(result(row.id, { status: 'undeliverable', attempts, last_error: res.description }));
    writes.push(db.prepare('UPDATE users SET blocked_at = ? WHERE telegram_id = ?').bind(now, row.user_id));
    state.blocked.add(row.user_id);
    stats.undeliverable += 1;
  } else if (res.errorCode === 400) {
    console.error(JSON.stringify({ event: 'deliver_400', [state.kind]: row.id, description: res.description }));
    writes.push(result(row.id, { status: 'failed', attempts, last_error: res.description }));
    stats.failed += 1;
  } else if (attempts >= MAX_ATTEMPTS) {
    writes.push(result(row.id, { status: 'failed', attempts, last_error: res.description }));
    stats.failed += 1;
  } else {
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    writes.push(result(row.id, { status: 'pending', attempts, next_attempt_at: now + delay, last_error: res.description }));
    stats.retry += 1;
  }
}

/** Получатель без доступа или заблокировавший бота — undeliverable без отправки. */
function undeliverable(row, state) {
  if (row.access === 'active' && row.blocked_at === null && !state.blocked.has(row.user_id)) return null;
  return row.access !== 'active' ? 'access revoked' : 'bot blocked';
}

export async function deliverStep(ctx) {
  const { db, now, budget } = ctx;
  const allowance = Math.min(TICK.deliverPerTick, budget.subrequestLimit - budget.subrequests - RESERVE_FOR_OTHER_STEPS - 3);
  if (allowance <= 0) return null;

  const [, due, , dueAlerts] = await db.batch([
    markStuckStatement(db, now),
    duePendingStatement(db, now, allowance),
    priceAlerts.markStuckStatement(db, now),
    priceAlerts.duePendingStatement(db, now, allowance),
  ]);
  const rows = due.results;
  const alerts = dueAlerts.results.slice(0, allowance - rows.length);
  if (rows.length === 0 && alerts.length === 0) return null;

  const searchIds = [...new Set(rows.flatMap((r) => JSON.parse(r.search_ids)))];
  const claims = [];
  if (rows.length) claims.push(claimStatement(db, rows.map((r) => r.id), now), searchTitlesStatement(db, searchIds));
  if (alerts.length) claims.push(priceAlerts.claimStatement(db, alerts.map((a) => a.id), now));
  const claimed = await db.batch(claims);
  const alertClaim = alerts.length ? claimed.at(-1) : null;
  if ((rows.length && claimed[0].meta.changes !== rows.length) || (alertClaim && alertClaim.meta.changes !== alerts.length)) {
    // Кто-то успел раньше (не должно случаться при аренде тика) — ничего не отправляем, чтобы не было дублей.
    return { skipped: 'claim-conflict' };
  }
  const titleById = new Map((rows.length ? claimed[1].results : []).map((t) => [t.id, t.title]));

  const state = {
    writes: [], lastSentToChat: new Map(), blocked: new Set(), stopped: false, kind: 'notification',
    stats: { sent: 0, retry: 0, failed: 0, undeliverable: 0 },
  };
  const { writes } = state;
  const notificationResult = (id, fields) => resultStatement(db, id, fields);
  for (const row of rows) {
    if (state.stopped) {
      writes.push(notificationResult(row.id, { status: 'pending', next_attempt_at: now }));
      continue;
    }
    const lost = undeliverable(row, state);
    if (lost) {
      writes.push(notificationResult(row.id, { status: 'undeliverable', last_error: lost }));
      state.stats.undeliverable += 1;
      continue;
    }
    const searchTitles = JSON.parse(row.search_ids).map((id) => titleById.get(id)).filter(Boolean);
    if (row.url === null || searchTitles.length === 0 || row.mark === 'hide') {
      const reason = row.url === null ? 'listing removed' : row.mark === 'hide' ? 'скрыто пользователем' : 'searches removed';
      writes.push(notificationResult(row.id, { status: 'failed', last_error: reason }));
      state.stats.failed += 1;
      continue;
    }
    const message = notificationMessage(row, { searchTitles, distanceLabel: row.distance_label, listingId: row.listing_id, mark: row.mark });
    await send(ctx, state, row, message, notificationResult);
  }

  const notifications = state.stats;
  state.stats = { sent: 0, retry: 0, failed: 0, undeliverable: 0, cancelled: 0 };
  state.kind = 'price_alert';
  const alertResult = (id, fields) => priceAlerts.resultStatement(db, id, fields);
  for (const alert of alerts) {
    if (state.stopped) {
      writes.push(alertResult(alert.id, { status: 'pending', next_attempt_at: now }));
      continue;
    }
    const lost = undeliverable(alert, state);
    if (lost) {
      writes.push(alertResult(alert.id, { status: 'undeliverable', last_error: lost }));
      state.stats.undeliverable += 1;
      continue;
    }
    if (alert.mark !== 'like') {
      writes.push(alertResult(alert.id, { status: 'cancelled', last_error: alert.mark === 'hide' ? 'скрыто пользователем' : 'лайк снят' }));
      state.stats.cancelled += 1;
      continue;
    }
    const message = priceAlertMessage(alert, { currency: alert.currency, oldPrice: alert.old_price, newPrice: alert.new_price });
    await send(ctx, state, alert, message, alertResult);
  }

  if (writes.length) await db.batch(writes);
  return alerts.length ? { ...notifications, prices: state.stats } : notifications;
}
