// Константы бота. Числа — из plan.md и research.md (R2, R3), лимиты — Конституция, принципы I и IV.

export const VERSION = '0.1.0';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const SOURCE_IDS = ['kufar', 'realt', 'domovita', 'moyareklama'];

// Тип объявления и группы типов в поиске (specs/002-search-ux-improvements/data-model.md).
export const KINDS = ['house', 'cottage', 'dacha', 'part'];
export const KIND_GROUPS = { house: ['house', 'cottage'], dacha: ['dacha'], part: ['part'] };
export const KIND_GROUP_IDS = Object.keys(KIND_GROUPS);
export const KIND_TITLES = { house: 'Дом', cottage: 'Коттедж', dacha: 'Дача', part: 'Часть дома' };

export function userAgent(env) {
  return `house-hunter-bot/${VERSION} (+https://t.me/${env.BOT_USERNAME})`;
}

export const TICK = {
  cpuBudget: 6,
  subrequestBudget: 45,
  deliverPerTick: 20,
  matchPerTick: 50,
  routesPerTick: 10,
  lockTtlMs: 5 * MINUTE,
};

export const FETCH_TIMEOUT_MS = 15_000;
export const SOURCE_MIN_GAP_MS = MINUTE;
export const FEED_JITTER_MS = 5 * MINUTE;
export const ROBOTS_MAX_AGE_MS = 26 * HOUR;
export const FAILS_TO_ALERT = 3;
export const OKS_TO_RECOVER = 3;
export const EMPTY_TO_FAIL = 3;
export const BLOCKED_BACKOFF_HOURS = [1, 2, 4, 8, 24];

export const MATCH_WAIT_MS = 20 * MINUTE;
export const SENDING_STUCK_MS = 10 * MINUTE;
export const RETRY_DELAYS_MS = [1, 5, 15, 60].map((m) => m * MINUTE);
export const CHAT_GAP_MS = 1_000;

export const NEW_BY_CREATED_MS = 48 * HOUR;
export const LAST_SEEN_UPDATE_MS = DAY;
export const LISTING_TTL_MS = 30 * DAY;
export const NOTIFICATION_TTL_MS = 365 * DAY;

export const INIT_DATA_MAX_AGE_S = 24 * 3600;

// Понравившиеся, страницы объявлений и цена (specs/003-listing-likes/research.md R2, R7–R10).
export const LIKES_MAX = 100;
export const CARD_CHECK_MS = DAY;
export const CARD_GAP_MS = 3 * MINUTE;
export const CARD_IDLE_MS = HOUR;
export const UNCHECKED_AFTER_MS = 7 * DAY;
export const PRICE_CHANGE_MIN = 0.01;
export const PRICE_ALERT_TTL_MS = 365 * DAY;

export const LIST_PAGE_SIZE = 5;
export const LIST_MAX_ROWS = 3000;
export const MAX_KM = 300;

export const ROUTING = {
  orsBase: 'https://api.heigit.org/openrouteservice/v2',
  osrmBase: 'https://routing.openstreetmap.de/routed-car',
  limits: { ors_directions: 2000, ors_matrix: 500, osrm: 300 },
  orsPerMinute: 40,
  matrixMaxDestinations: 3499,
  maxAttempts: 3,
};

export const NBRB_RATE_URL = 'https://api.nbrb.by/exrates/rates/USD';
