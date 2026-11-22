/** Аренда по data-model.md locks: `changes = 1` — захвачено. */
export async function acquireLock(db, name, holder, now, ttlMs) {
  const r = await db
    .prepare('UPDATE locks SET holder = ?, expires_at = ? WHERE name = ? AND expires_at < ?')
    .bind(holder, now + ttlMs, name, now)
    .run();
  return r.meta.changes === 1;
}

export async function releaseLock(db, name, holder) {
  await db.prepare('UPDATE locks SET holder = NULL, expires_at = 0 WHERE name = ? AND holder = ?').bind(name, holder).run();
}
