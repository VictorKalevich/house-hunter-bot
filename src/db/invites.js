// data-model.md invites.

export const INVITE_PREFIX = 'inv_';

/** 16 случайных байт в base64url — 22 символа. */
export function newInviteToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function inviteLink(botUsername, token) {
  return `https://t.me/${botUsername}?start=${INVITE_PREFIX}${token}`;
}

export async function createInvite(db, ownerId, now) {
  const token = newInviteToken();
  await db.prepare('INSERT INTO invites (token, created_by, created_at) VALUES (?, ?, ?)').bind(token, ownerId, now).run();
  return token;
}

/**
 * Одноразовый вход: пользователь создаётся и приглашение тратится в одной транзакции (batch).
 * Запись в D1 идёт по одной транзакции за раз, поэтому успех — только у того, чей UPDATE изменил строку.
 * @returns {Promise<boolean>}
 */
export async function useInvite(db, token, from, now) {
  const firstName = String(from.first_name ?? '').trim() || 'Без имени';
  const [, upd] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO users (telegram_id, first_name, username, role, access, invited_by, created_at)
         SELECT ?, ?, ?, 'member', 'active', created_by, ? FROM invites WHERE token = ? AND used_by IS NULL`,
      )
      .bind(from.id, firstName, from.username ?? null, now, token),
    db
      .prepare(
        `UPDATE invites SET used_by = ?, used_at = ?
         WHERE token = ? AND used_by IS NULL
           AND EXISTS (SELECT 1 FROM users WHERE telegram_id = ? AND access = 'active')`,
      )
      .bind(from.id, now, token, from.id),
  ]);
  return upd.meta.changes === 1;
}
