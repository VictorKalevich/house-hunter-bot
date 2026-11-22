// data-model.md feeds.

export function updateFeedStatement(db, id, fields) {
  const keys = Object.keys(fields);
  return db
    .prepare(`UPDATE feeds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id);
}
