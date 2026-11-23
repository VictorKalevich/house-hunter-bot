// specs/003-listing-likes/data-model.md price_alerts: сообщения об изменении цены понравившегося.
import { SENDING_STUCK_MS } from '../config.js';

/**
 * По одному сообщению каждому, у кого объявление в понравившихся. Идёт в одном batch с записью новой цены:
 * повтор той же выдачи видит цену уже записанной и ничего не вставляет.
 * @param {{currency: string, oldPrice: number, newPrice: number}} change
 */
export function insertForLikesStatement(db, listingId, change, now) {
  return db
    .prepare(
      `INSERT INTO price_alerts (user_id, listing_id, currency, old_price, new_price, created_at)
       SELECT user_id, listing_id, ?, ?, ?, ? FROM marks WHERE kind = 'like' AND listing_id = ?`,
    )
    .bind(change.currency, change.oldPrice, change.newPrice, now, listingId);
}

/** Зависшие в `sending` дольше 10 минут — `uncertain`, как у уведомлений. */
export function markStuckStatement(db, now) {
  return db
    .prepare("UPDATE price_alerts SET status = 'uncertain', last_error = 'прервано во время отправки' WHERE status = 'sending' AND next_attempt_at < ?")
    .bind(now - SENDING_STUCK_MS);
}

export function duePendingStatement(db, now, limit) {
  return db
    .prepare(
      `SELECT a.id, a.user_id, a.listing_id, a.currency, a.old_price, a.new_price, a.attempts,
              u.access, u.blocked_at, m.kind AS mark,
              l.source, l.url, l.kind, l.price_usd, l.price_byn, l.house_m2, l.plot_sotki, l.place_text, l.photo_url
       FROM price_alerts a
       JOIN users u ON u.telegram_id = a.user_id
       JOIN listings l ON l.id = a.listing_id
       LEFT JOIN marks m ON m.user_id = a.user_id AND m.listing_id = a.listing_id
       WHERE a.status = 'pending' AND a.next_attempt_at <= ?
       ORDER BY a.next_attempt_at, a.id
       LIMIT ?`,
    )
    .bind(now, limit);
}

export function claimStatement(db, ids, now) {
  return db
    .prepare(`UPDATE price_alerts SET status = 'sending', next_attempt_at = ? WHERE status = 'pending' AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(now, ...ids);
}

export function resultStatement(db, id, fields) {
  const keys = Object.keys(fields);
  return db
    .prepare(`UPDATE price_alerts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id);
}
