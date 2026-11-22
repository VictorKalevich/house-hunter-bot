-- Схема D1 по specs/001-house-listing-alerts/data-model.md. Время — мс Unix (UTC).
-- D1 всегда проверяет внешние ключи: ссылки на удаляемые строки — ON DELETE SET NULL или CASCADE.

CREATE TABLE users (
  telegram_id INTEGER PRIMARY KEY,
  first_name  TEXT NOT NULL,
  username    TEXT,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  access      TEXT NOT NULL DEFAULT 'active' CHECK (access IN ('active', 'revoked')),
  invited_by  INTEGER REFERENCES users (telegram_id),
  blocked_at  INTEGER,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE TABLE access_denials (
  telegram_id INTEGER PRIMARY KEY,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1)
);

CREATE TABLE invites (
  token      TEXT PRIMARY KEY CHECK (length(token) = 22),
  created_by INTEGER NOT NULL REFERENCES users (telegram_id),
  created_at INTEGER NOT NULL,
  used_by    INTEGER REFERENCES users (telegram_id),
  used_at    INTEGER
);

CREATE TABLE settlements (
  id        INTEGER PRIMARY KEY,
  osm_ref   TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  kind      TEXT NOT NULL,
  district  TEXT,
  region    TEXT NOT NULL,
  lat       REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon       REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
  rank      INTEGER NOT NULL
);
CREATE INDEX settlements_name_norm ON settlements (name_norm, rank);

CREATE TABLE settlement_shapes (
  settlement_id INTEGER PRIMARY KEY REFERENCES settlements (id) ON DELETE CASCADE,
  polygon       TEXT NOT NULL,
  radius_km     REAL NOT NULL CHECK (radius_km >= 0),
  source        TEXT NOT NULL CHECK (source IN ('osm', 'circle'))
);

CREATE TABLE sources (
  id                   TEXT PRIMARY KEY CHECK (id IN ('kufar', 'realt', 'domovita', 'moyareklama')),
  state                TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'failing', 'blocked', 'disallowed')),
  last_request_at      INTEGER,
  max_id_seen          INTEGER,
  new_id_floor         INTEGER,
  id_snapshot          INTEGER,
  robots_checked_at    INTEGER,
  adapter_state        TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  error_kind           TEXT CHECK (error_kind IN ('http', 'blocked', 'parse', 'empty')),
  error_text           TEXT,
  failing_since        INTEGER,
  alerted_at           INTEGER,
  backoff_level        INTEGER NOT NULL DEFAULT 0,
  next_check_at        INTEGER,
  last_ok_at           INTEGER,
  last_checked_at      INTEGER
);

CREATE TABLE feeds (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL REFERENCES sources (id),
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  page         INTEGER NOT NULL DEFAULT 1 CHECK (page >= 1),
  page_cursor  TEXT,
  prev_ids     TEXT,
  cycle_ids    TEXT,
  empty_streak INTEGER NOT NULL DEFAULT 0,
  last_ok_at   INTEGER
);
CREATE INDEX feeds_due ON feeds (next_poll_at);

CREATE TABLE listings (
  id                  INTEGER PRIMARY KEY,
  source              TEXT NOT NULL REFERENCES sources (id),
  external_id         TEXT NOT NULL,
  url                 TEXT NOT NULL CHECK (url LIKE 'https://%'),
  price_usd           REAL CHECK (price_usd > 0),
  price_byn           REAL CHECK (price_byn > 0),
  house_m2            REAL CHECK (house_m2 > 0),
  plot_sotki          REAL CHECK (plot_sotki > 0),
  lat                 REAL,
  lon                 REAL,
  geo_approx          INTEGER NOT NULL DEFAULT 0 CHECK (geo_approx IN (0, 1)),
  geo_key             TEXT,
  settlement_id       INTEGER REFERENCES settlements (id) ON DELETE SET NULL,
  place_text          TEXT NOT NULL,
  photo_url           TEXT,
  published_at        INTEGER,
  site_created_at     INTEGER,
  is_new              INTEGER NOT NULL CHECK (is_new IN (0, 1)),
  sort_at             INTEGER NOT NULL,
  first_seen_at       INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  match_state         TEXT NOT NULL CHECK (match_state IN ('pending', 'done')),
  match_waiting_since INTEGER,
  needs_detail        INTEGER NOT NULL DEFAULT 0 CHECK (needs_detail IN (0, 1)),
  UNIQUE (source, external_id)
);
-- Частичные индексы пишутся только для подходящих строк — экономят записи D1.
CREATE INDEX listings_pending ON listings (first_seen_at) WHERE match_state = 'pending';
CREATE INDEX listings_needs_detail ON listings (source, first_seen_at) WHERE needs_detail = 1;
CREATE INDEX listings_lat ON listings (lat);
CREATE INDEX listings_sort_at ON listings (sort_at);
CREATE INDEX listings_last_seen_at ON listings (last_seen_at);

CREATE TABLE searches (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (telegram_id),
  title          TEXT NOT NULL,
  settlement_id  INTEGER REFERENCES settlements (id),
  distance_mode  TEXT NOT NULL DEFAULT 'straight' CHECK (distance_mode IN ('straight', 'road_center', 'road_exit')),
  max_km         REAL CHECK (max_km BETWEEN 1 AND 300),
  price_min_usd  REAL CHECK (price_min_usd >= 0),
  price_max_usd  REAL CHECK (price_max_usd >= 0),
  house_min_m2   REAL CHECK (house_min_m2 >= 0),
  house_max_m2   REAL CHECK (house_max_m2 >= 0),
  plot_min_sotki REAL CHECK (plot_min_sotki >= 0),
  plot_max_sotki REAL CHECK (plot_max_sotki >= 0),
  sources        TEXT NOT NULL CHECK (sources <> ''),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  active_since   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (max_km IS NULL OR settlement_id IS NOT NULL),
  CHECK (price_min_usd IS NULL OR price_max_usd IS NULL OR price_min_usd <= price_max_usd),
  CHECK (house_min_m2 IS NULL OR house_max_m2 IS NULL OR house_min_m2 <= house_max_m2),
  CHECK (plot_min_sotki IS NULL OR plot_max_sotki IS NULL OR plot_min_sotki <= plot_max_sotki)
);
CREATE INDEX searches_user ON searches (user_id);
CREATE INDEX searches_active ON searches (status);

CREATE TABLE distances (
  settlement_id  INTEGER NOT NULL REFERENCES settlements (id) ON DELETE CASCADE,
  geo_key        TEXT NOT NULL,
  straight_km    REAL NOT NULL CHECK (straight_km >= 0),
  road_center_km REAL CHECK (road_center_km >= 0),
  road_exit_km   REAL CHECK (road_exit_km >= 0),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  priority       INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
  attempts       INTEGER NOT NULL DEFAULT 0,
  requested_at   INTEGER NOT NULL,
  computed_at    INTEGER,
  PRIMARY KEY (settlement_id, geo_key)
) WITHOUT ROWID;
CREATE INDEX distances_queue ON distances (priority DESC, requested_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users (telegram_id),
  source          TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  listing_id      INTEGER REFERENCES listings (id) ON DELETE SET NULL,
  search_ids      TEXT NOT NULL,
  distance_label  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'undeliverable', 'uncertain')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (user_id, source, external_id)
);
CREATE INDEX notifications_queue ON notifications (status, next_attempt_at);
CREATE INDEX notifications_listing ON notifications (listing_id);
CREATE INDEX notifications_created ON notifications (created_at);

CREATE TABLE rates (
  date       TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  usd_byn    REAL NOT NULL CHECK (usd_byn > 0),
  fetched_at INTEGER NOT NULL
);

CREATE TABLE service_quota (
  service      TEXT PRIMARY KEY CHECK (service IN ('ors_directions', 'ors_matrix', 'osrm')),
  day          TEXT NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  paused_until INTEGER
);

CREATE TABLE locks (
  name       TEXT PRIMARY KEY,
  holder     TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO locks (name, holder, expires_at) VALUES ('tick', NULL, 0);
