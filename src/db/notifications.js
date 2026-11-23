// data-model.md notifications.
import { SENDING_STUCK_MS } from '../config.js';

/** Зависшие в `sending` дольше 10 минут — `uncertain`: вызов прервали после отправки, повтор дал бы дубль. */
export function markStuckStatement(db, now) {
  return db
    .prepare("UPDATE notifications SET status = 'uncertain', last_error = 'прервано во время отправки' WHERE status = 'sending' AND next_attempt_at < ?")
    .bind(now - SENDING_STUCK_MS);
}

export function duePendingStatement(db, now, limit) {
  return db
    .prepare(
      `SELECT n.id, n.user_id, n.source, n.external_id, n.listing_id, n.search_ids, n.distance_label, n.attempts,
              u.access, u.blocked_at,
              l.url, l.kind, l.price_usd, l.price_byn, l.house_m2, l.plot_sotki, l.place_text, l.photo_url,
              m.kind AS mark
       FROM notifications n
       JOIN users u ON u.telegram_id = n.user_id
       LEFT JOIN listings l ON l.id = n.listing_id
       LEFT JOIN marks m ON m.user_id = n.user_id AND m.listing_id = n.listing_id
       WHERE n.status = 'pending' AND n.next_attempt_at <= ?
       ORDER BY n.next_attempt_at, n.id
       LIMIT ?`,
    )
    .bind(now, limit);
}

/** Захват строк в отправку: `pending → sending`, время захвата — в next_attempt_at. */
export function claimStatement(db, ids, now) {
  return db
    .prepare(`UPDATE notifications SET status = 'sending', next_attempt_at = ? WHERE status = 'pending' AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(now, ...ids);
}

export function resultStatement(db, id, fields) {
  const keys = Object.keys(fields);
  return db
    .prepare(`UPDATE notifications SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id);
}

export function searchTitlesStatement(db, ids) {
  return db.prepare(`SELECT id, title FROM searches WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids);
}
