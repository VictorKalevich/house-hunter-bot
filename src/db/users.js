// data-model.md users, access_denials.

export function getUser(db, telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(telegramId).first();
}

/** Владелец: запись создаётся или обновляется при каждом обращении (role = owner, access = active). */
export async function upsertOwner(db, from, now) {
  await db
    .prepare(
      `INSERT INTO users (telegram_id, first_name, username, role, access, created_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)
       ON CONFLICT (telegram_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
         role = 'owner', access = 'active', blocked_at = NULL, revoked_at = NULL`,
    )
    .bind(from.id, firstName(from), from.username ?? null, now)
    .run();
  return getUser(db, from.id);
}

/** Пользователь написал боту: обновить имя и снять отметку «заблокировал бота». */
export async function touchUser(db, user, from) {
  const name = firstName(from);
  const username = from.username ?? null;
  if (user.first_name === name && user.username === username && user.blocked_at === null) return user;
  await db
    .prepare('UPDATE users SET first_name = ?, username = ?, blocked_at = NULL WHERE telegram_id = ?')
    .bind(name, username, from.id)
    .run();
  return { ...user, first_name: name, username, blocked_at: null };
}

export async function recordDenial(db, telegramId, now) {
  await db
    .prepare(
      `INSERT INTO access_denials (telegram_id, first_at, last_at, attempts) VALUES (?, ?, ?, 1)
       ON CONFLICT (telegram_id) DO UPDATE SET last_at = excluded.last_at, attempts = attempts + 1`,
    )
    .bind(telegramId, now, now)
    .run();
}

export async function markBlocked(db, telegramId, now) {
  await db.prepare('UPDATE users SET blocked_at = ? WHERE telegram_id = ?').bind(now, telegramId).run();
}

export async function listUsers(db, offset, limit) {
  const { results } = await db
    .prepare(
      `SELECT telegram_id, first_name, username, role, access, created_at FROM users
       ORDER BY created_at, telegram_id LIMIT ? OFFSET ?`,
    )
    .bind(limit + 1, offset)
    .all();
  return { items: results.slice(0, limit), more: results.length > limit };
}

/** Закрыть доступ: поиски остаются, ожидающие уведомления — undeliverable (data-model.md notifications). */
export async function revokeUser(db, telegramId, now) {
  const [upd] = await db.batch([
    db
      .prepare("UPDATE users SET access = 'revoked', revoked_at = ? WHERE telegram_id = ? AND role <> 'owner' AND access = 'active'")
      .bind(now, telegramId),
    db
      .prepare(
        `UPDATE notifications SET status = 'undeliverable', last_error = 'access revoked'
         WHERE user_id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM users WHERE telegram_id = ? AND access = 'revoked')`,
      )
      .bind(telegramId, telegramId),
  ]);
  return upd.meta.changes === 1;
}

function firstName(from) {
  return String(from.first_name ?? '').trim() || 'Без имени';
}
