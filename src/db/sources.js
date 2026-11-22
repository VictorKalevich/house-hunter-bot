// data-model.md sources, feeds; состояние для пользователей — specs/002-search-ux-improvements/data-model.md.
import { FAILS_TO_ALERT } from '../config.js';
import { SOURCE_TITLES } from '../sources/titles.js';

/** Сбой подтверждён: по этому же правилу владелец получает сообщение о сбое. */
export function isConfirmedFailure(src) {
  if (!src) return false;
  if (src.state === 'blocked' || src.state === 'disallowed') return true;
  return src.state === 'failing' && src.consecutive_failures >= FAILS_TO_ALERT;
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * SourceStatus для мини-приложения: down — подтверждённый сбой, collecting — первый круг лент не закончен
 * (у ленты нет строки или last_ok_at), ok — остальное. Без технических подробностей сбоя.
 * @param {object[]} sources строки sources
 * @param {object[]} feeds строки feeds
 * @param {Array<{id: string, feeds: object[]}>} adapters в порядке показа
 * @param {(adapter: object, feed: object) => string} feedIdOf
 */
export function userSourcesStatus(sources, feeds, adapters, feedIdOf) {
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const readFeeds = new Set(feeds.filter((f) => f.last_ok_at !== null && f.last_ok_at !== undefined).map((f) => f.id));
  return adapters.map((adapter) => {
    const src = sourceById.get(adapter.id) ?? null;
    const down = isConfirmedFailure(src);
    const collecting = !down && adapter.feeds.some((feed) => !readFeeds.has(feedIdOf(adapter, feed)));
    return {
      id: adapter.id,
      title: SOURCE_TITLES[adapter.id] ?? adapter.id,
      state: down ? 'down' : collecting ? 'collecting' : 'ok',
      since: down ? iso(src.failing_since) : null,
      checkedAt: iso(src?.last_ok_at),
    };
  });
}

/** Строки для userSourcesStatus — только нужные поля (без списков номеров лент). */
export async function sourcesStatusRows(db) {
  const [sources, feeds] = await db.batch([
    db.prepare('SELECT id, state, consecutive_failures, failing_since, last_ok_at FROM sources'),
    db.prepare('SELECT id, last_ok_at FROM feeds'),
  ]);
  return { sources: sources.results, feeds: feeds.results };
}

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
