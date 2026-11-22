/**
 * Обёртка над D1 для тика: каждый запрос и `batch()` считается подзапросом в бюджете,
 * `rows_read`/`rows_written` из `meta` складываются в счётчики для лога.
 * Интерфейс совпадает с D1Database в той части, что использует код (`prepare`, `bind`, `all`, `run`, `first`, `batch`).
 */
export function trackDb(db, budget) {
  const stats = { queries: 0, rows_read: 0, rows_written: 0 };
  const note = (meta) => {
    stats.queries += 1;
    stats.rows_read += meta?.rows_read ?? 0;
    stats.rows_written += meta?.rows_written ?? 0;
  };

  const wrap = (stmt) => ({
    raw: stmt,
    bind: (...args) => wrap(stmt.bind(...args)),
    async all() {
      budget?.use(1);
      const r = await stmt.all();
      note(r.meta);
      return r;
    },
    async run() {
      budget?.use(1);
      const r = await stmt.run();
      note(r.meta);
      return r;
    },
    async first(column) {
      const { results } = await this.all();
      const row = results[0] ?? null;
      if (column === undefined) return row;
      return row ? (row[column] ?? null) : null;
    },
  });

  return {
    stats,
    prepare: (sql) => wrap(db.prepare(sql)),
    async batch(statements) {
      if (statements.length === 0) return [];
      budget?.use(1);
      const results = await db.batch(statements.map((s) => s.raw ?? s));
      stats.queries -= results.length - 1;
      for (const r of results) note(r.meta);
      return results;
    },
  };
}
