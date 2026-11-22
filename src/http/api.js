// HTTP API мини-приложения (contracts/miniapp-api.md).
import { LIST_PAGE_SIZE } from '../config.js';
import { enqueueStatement } from '../db/distances.js';
import { searchListings } from '../db/listings.js';
import {
  createSearch, deleteSearch, getOwnSearch, listOwnSearches, pauseSearch, resumeSearch, searchToApi, settlementOf,
  updateSearch,
} from '../db/searches.js';
import { sourcesStatusRows, userSourcesStatus } from '../db/sources.js';
import { getUser, upsertOwner } from '../db/users.js';
import { getSettlement, suggestSettlements } from '../geo/gazetteer.js';
import { listingCard } from '../match/format.js';
import { buildTitle, validateCriteria } from '../match/validate.js';
import { ADAPTERS, feedId } from '../sources/index.js';
import { verifyInitData } from './miniapp-auth.js';

// Сколько пар «пункт × место» ставить в очередь маршрутов за один запрос списка (одна пачка D1).
const LIST_ENQUEUE_MAX = 100;

class ApiError extends Error {
  constructor(status, code, message, fields = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const NOT_FOUND = () => new ApiError(404, 'not_found', 'Поиск не найден');

function json(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Пользователь — только из проверенного initData; доступ — users.access = active или владелец. */
async function authenticate(request, env, now) {
  const header = request.headers.get('authorization') ?? '';
  const initData = header.startsWith('tma ') ? header.slice(4) : '';
  const verified = await verifyInitData(initData, env.BOT_TOKEN, now);
  if (verified.error) throw new ApiError(401, 'unauthorized', 'Откройте приложение из чата с ботом');
  const from = verified.user;
  const isOwner = Boolean(env.OWNER_TELEGRAM_ID) && String(from.id) === String(env.OWNER_TELEGRAM_ID);
  let user = await getUser(env.DB, from.id);
  if (isOwner && (!user || user.role !== 'owner' || user.access !== 'active')) user = await upsertOwner(env.DB, from, now);
  if (!user || user.access !== 'active') throw new ApiError(403, 'no_access', 'Нет доступа: бот работает по приглашению');
  return { id: from.id, firstName: user.first_name ?? from.first_name ?? '', isOwner };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError(422, 'invalid', 'Неверные условия', { body: 'Ожидается JSON' });
  }
}

/** Проверка Criteria и существования пункта; ошибки — 422 с fields. */
async function criteriaFrom(request, db) {
  const { criteria, fields } = validateCriteria(await readBody(request));
  let settlement = null;
  if (criteria?.settlementId != null) {
    settlement = await getSettlement(db, criteria.settlementId);
    if (!settlement) fields.settlementId = 'Такого населённого пункта нет в справочнике — выберите из списка';
  }
  if (!criteria || Object.keys(fields).length) throw new ApiError(422, 'invalid', 'Проверьте условия поиска', fields);
  return { criteria, settlement };
}

async function ownSearch(db, userId, id) {
  const row = await getOwnSearch(db, userId, id);
  if (!row) throw NOT_FOUND();
  return row;
}

/** Пары без дорожного расстояния — в очередь маршрутов с приоритетом списка (data-model.md distances.priority). */
async function enqueueMissing(db, row, missing, now) {
  if (!missing.length) return;
  await db.batch(missing.slice(0, LIST_ENQUEUE_MAX).map((m) => enqueueStatement(db, {
    settlementId: row.settlement_id, geoKey: m.geo_key, straightKm: m.straight_km, priority: 0,
    needExit: row.distance_mode === 'road_exit', now,
  })));
}

function listingsOf(db, row, page, now) {
  return searchListings(db, row, { settlement: settlementOf(row), radiusKm: row.settlement_radius_km ?? 0, page, now });
}

/** После создания и изменения поиска с расстоянием по дороге — начать считать маршруты для его списка. */
async function prepareRoutes(db, row, now) {
  if (row.max_km === null || row.settlement_id === null || row.distance_mode === 'straight') return;
  const { missing } = await listingsOf(db, row, 1, now);
  await enqueueMissing(db, row, missing, now);
}

async function route(request, env, url, user, now) {
  const db = env.DB;
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/me' && method === 'GET') return json(200, { firstName: user.firstName, isOwner: user.isOwner });

  if (path === '/api/settlements' && method === 'GET') {
    const items = await suggestSettlements(db, url.searchParams.get('q') ?? '');
    return json(200, { items: items.map((s) => ({ id: s.id, name: s.name, kind: s.kind, district: s.district, region: s.region })) });
  }

  if (path === '/api/sources' && method === 'GET') {
    const { sources, feeds } = await sourcesStatusRows(db);
    return json(200, { items: userSourcesStatus(sources, feeds, ADAPTERS, feedId) });
  }

  if (path === '/api/searches') {
    if (method === 'GET') return json(200, { items: (await listOwnSearches(db, user.id)).map(searchToApi) });
    if (method === 'POST') {
      const { criteria, settlement } = await criteriaFrom(request, db);
      const id = await createSearch(db, user.id, criteria, buildTitle(criteria, settlement), now);
      const row = await ownSearch(db, user.id, id);
      await prepareRoutes(db, row, now);
      return json(201, searchToApi(row));
    }
  }

  const m = /^\/api\/searches\/(\d{1,15})(?:\/(listings|pause|resume))?$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    const action = m[2] ?? null;

    if (action === null && method === 'GET') return json(200, searchToApi(await ownSearch(db, user.id, id)));
    if (action === null && method === 'PUT') {
      await ownSearch(db, user.id, id);
      const { criteria, settlement } = await criteriaFrom(request, db);
      if (!(await updateSearch(db, user.id, id, criteria, buildTitle(criteria, settlement), now))) throw NOT_FOUND();
      const row = await ownSearch(db, user.id, id);
      await prepareRoutes(db, row, now);
      return json(200, searchToApi(row));
    }
    if (action === null && method === 'DELETE') {
      if (!(await deleteSearch(db, user.id, id))) throw NOT_FOUND();
      return json(204, null);
    }
    if ((action === 'pause' || action === 'resume') && method === 'POST') {
      const done = action === 'pause' ? await pauseSearch(db, user.id, id, now) : await resumeSearch(db, user.id, id, now);
      if (!done) throw NOT_FOUND();
      return json(200, searchToApi(await ownSearch(db, user.id, id)));
    }
    if (action === 'listings' && method === 'GET') {
      const raw = url.searchParams.get('page') ?? '1';
      const page = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
      if (page < 1) throw new ApiError(422, 'invalid', 'Неверный номер страницы', { page: 'Номер страницы — целое число от 1' });
      const row = await ownSearch(db, user.id, id);
      const { rows, total, missing } = await listingsOf(db, row, page, now);
      await enqueueMissing(db, row, missing, now);
      return json(200, {
        items: rows.map(({ row: listing, distance }) => listingCard(listing, distance)),
        page,
        pageSize: LIST_PAGE_SIZE,
        total,
      });
    }
  }

  throw new ApiError(404, 'not_found', 'Нет такого адреса');
}

/** @param {Request} request */
export async function handleApi(request, env, url, now = Date.now()) {
  try {
    const user = await authenticate(request, env, now);
    return await route(request, env, url, user, now);
  } catch (err) {
    if (err instanceof ApiError) {
      return json(err.status, { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    }
    console.error(JSON.stringify({ event: 'api_error', path: url.pathname, error: String(err?.stack ?? err) }));
    return json(500, { error: { code: 'internal', message: 'Что-то пошло не так. Попробуйте ещё раз' } });
  }
}
