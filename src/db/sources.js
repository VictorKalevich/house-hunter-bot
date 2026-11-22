// data-model.md sources, feeds.

export async function listSources(db) {
  const { results } = await db.prepare('SELECT * FROM sources ORDER BY id').all();
  return results;
}

/** Источники и ленты одним запросом (batch). */
export async function loadSourcesAndFeeds(db) {
  const [sources, feeds] = await db.batch([
    db.prepare('SELECT * FROM sources'),
    db.prepare('SELECT * FROM feeds ORDER BY next_poll_at, id'),
  ]);
  return { sources: sources.results, feeds: feeds.results };
}

/** Строки источников и лент из адаптеров, если их ещё нет. */
export function ensureStatements(db, adapters, feedIdOf, haveSources, haveFeeds, now) {
  const stmts = [];
  for (const adapter of adapters) {
    if (!haveSources.has(adapter.id)) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO sources (id, state) VALUES (?, 'ok')").bind(adapter.id));
    }
    adapter.feeds.forEach((feed, i) => {
      const id = feedIdOf(adapter, feed);
      if (!haveFeeds.has(id)) {
        // Первые круги лент одного источника разнесены по времени.
        stmts.push(
          db.prepare('INSERT OR IGNORE INTO feeds (id, source, next_poll_at) VALUES (?, ?, ?)').bind(id, adapter.id, now + i * 60_000),
        );
      }
    });
  }
  return stmts;
}

/**
 * Занять сайт: не больше одного запроса в минуту (принцип I). Атомарно — даже если суточная задача и тик
 * идут одновременно. @returns {Promise<boolean>}
 */
export async function claimSite(db, sourceId, now, gapMs) {
  const r = await db
    .prepare('UPDATE sources SET last_request_at = ? WHERE id = ? AND (last_request_at IS NULL OR last_request_at <= ?)')
    .bind(now, sourceId, now - gapMs)
    .run();
  return r.meta.changes === 1;
}

/** Обновление строки источника: только переданные поля. */
export function updateSourceStatement(db, id, fields) {
  const keys = Object.keys(fields);
  return db
    .prepare(`UPDATE sources SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id);
}

/** «Проверить сейчас»: ленты источника — в ближайший тик; заблокированный — одна внеочередная проверка. */
export async function probeSource(db, sourceId, now) {
  await db.batch([
    db.prepare('UPDATE feeds SET next_poll_at = ? WHERE source = ?').bind(now, sourceId),
    db
      .prepare(
        `UPDATE sources SET next_check_at = CASE WHEN next_check_at IS NOT NULL THEN ? ELSE NULL END,
           robots_checked_at = CASE WHEN state = 'disallowed' THEN NULL ELSE robots_checked_at END
         WHERE id = ?`,
      )
      .bind(now, sourceId),
  ]);
}
