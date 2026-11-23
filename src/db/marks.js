// data-model.md 003 marks: лайк и «Не интересно» — одна строка на пару пользователь + объявление (research.md R2).
import { LIKES_MAX, LIST_PAGE_SIZE } from '../config.js';

export async function getMark(db, userId, listingId) {
  const row = await db.prepare('SELECT kind FROM marks WHERE user_id = ? AND listing_id = ?').bind(userId, listingId).first();
  return row?.kind ?? null;
}

function writeStatement(db, userId, listingId, mark, now, only) {
  if (mark === null) {
    return only
      ? db.prepare('DELETE FROM marks WHERE user_id = ? AND listing_id = ? AND kind = ?').bind(userId, listingId, only)
      : db.prepare('DELETE FROM marks WHERE user_id = ? AND listing_id = ?').bind(userId, listingId);
  }
  // Время меняется только при смене вида: повторный лайк не поднимает дом в начало списка.
  const upsert = `ON CONFLICT (user_id, listing_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at
    WHERE marks.kind <> excluded.kind`;
  if (mark === 'hide') {
    return db
      .prepare(`INSERT INTO marks (user_id, listing_id, kind, created_at) SELECT ?, id, 'hide', ? FROM listings WHERE id = ? ${upsert}`)
      .bind(userId, now, listingId);
  }
  return db
    .prepare(
      `INSERT INTO marks (user_id, listing_id, kind, created_at) SELECT ?, id, 'like', ? FROM listings
       WHERE id = ? AND (SELECT COUNT(*) FROM marks WHERE user_id = ? AND kind = 'like' AND listing_id <> ?) < ? ${upsert}`,
    )
    .bind(userId, now, listingId, userId, listingId, LIKES_MAX);
}

/**
 * Поставить (`like`, `hide`) или снять (`null`) отметку. `only` при снятии — снять только отметку этого вида
 * (кнопки «убрать из понравившихся» и «вернуть»).
 * @returns {Promise<{mark: 'like'|'hide'|null, url: string} | {error: 'not_found'|'like_limit'}>}
 */
export async function setMark(db, userId, listingId, mark, now, { only = null } = {}) {
  const [, state] = await db.batch([
    writeStatement(db, userId, listingId, mark, now, only),
    db
      .prepare(
        `SELECT (SELECT kind FROM marks WHERE user_id = ? AND listing_id = ?) AS mark,
                (SELECT url FROM listings WHERE id = ?) AS url`,
      )
      .bind(userId, listingId, listingId),
  ]);
  const row = state.results[0];
  if (row.url === null) return { error: 'not_found' };
  if (mark === 'like' && row.mark !== 'like') return { error: 'like_limit' };
  return { mark: row.mark ?? null, url: row.url };
}

/**
 * Страница отметок пользователя одного вида, последние сверху, и пункт самого нового поиска с пунктом
 * (для расстояния по прямой, research.md R11).
 * @returns {Promise<{rows: object[], total: number, settlement: {name: string, lat: number, lon: number}|null}>}
 */
export async function listMarks(db, userId, kind, page) {
  const [rows, count, settlement] = await db.batch([
    db
      .prepare(
        `SELECT l.*, m.kind AS mark FROM marks m JOIN listings l ON l.id = m.listing_id
         WHERE m.user_id = ? AND m.kind = ? ORDER BY m.created_at DESC, m.listing_id DESC LIMIT ? OFFSET ?`,
      )
      .bind(userId, kind, LIST_PAGE_SIZE, (page - 1) * LIST_PAGE_SIZE),
    db.prepare('SELECT COUNT(*) AS n FROM marks WHERE user_id = ? AND kind = ?').bind(userId, kind),
    db
      .prepare(
        `SELECT st.name, st.lat, st.lon FROM searches s JOIN settlements st ON st.id = s.settlement_id
         WHERE s.user_id = ? ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
      )
      .bind(userId),
  ]);
  return { rows: rows.results, total: count.results[0].n, settlement: settlement.results[0] ?? null };
}
