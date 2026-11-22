// Шаг тика «ленты»: contracts/source-adapter.md «Ошибки и состояние источника», принцип I.
import {
  BLOCKED_BACKOFF_HOURS, EMPTY_TO_FAIL, FAILS_TO_ALERT, FEED_JITTER_MS, FETCH_TIMEOUT_MS, HOUR, MINUTE,
  ROBOTS_MAX_AGE_MS, SOURCE_MIN_GAP_MS, userAgent,
} from '../config.js';
import { claimSite, ensureStatements, loadSourcesAndFeeds, updateSourceStatement } from '../db/sources.js';
import { updateFeedStatement } from '../db/feeds.js';
import { pendingDetail, detailResultStatement } from '../db/listings.js';
import { ADAPTERS, feedId } from '../sources/index.js';
import { isAllowed, parseRobots } from '../sources/robots.js';
import { failureAlertText, recoveryText, sendOwnerAlert } from '../telegram/owner-alerts.js';

const FAILING_RETRY_MS = 5 * MINUTE;
const PREV_IDS_MAX = 300;
const BLOCK_MARKERS = ['Just a moment...', 'cf-browser-verification', 'challenge-platform', 'cf-chl-', 'Attention Required!', 'captcha'];
const REASON_PHRASES = { 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** Работа для сайта в этом тике: robots.txt, карточка объявления или страница ленты. */
function robotsDue(src, now) {
  return src.robots_checked_at === null || src.robots_checked_at < now - ROBOTS_MAX_AGE_MS;
}

export async function pollFeedsStep(ctx) {
  const { db, env, now, budget } = ctx;
  let { sources, feeds } = await loadSourcesAndFeeds(db);
  const ensure = ensureStatements(db, ADAPTERS, feedId, new Set(sources.map((s) => s.id)), new Set(feeds.map((f) => f.id)), now);
  if (ensure.length) {
    await db.batch(ensure);
    ({ sources, feeds } = await loadSourcesAndFeeds(db));
  }
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const plans = [];
  for (const adapter of ADAPTERS) {
    const src = sourceById.get(adapter.id);
    if (!src || !budget.siteFree(adapter.id)) continue;
    if (src.last_request_at !== null && src.last_request_at > now - SOURCE_MIN_GAP_MS) continue;
    if ((src.next_check_at ?? 0) > now) continue;
    const ownFeeds = feeds.filter((f) => f.source === adapter.id);
    if (robotsDue(src, now)) {
      plans.push({ adapter, src, kind: 'robots', order: -1, cost: 1, feeds: ownFeeds });
      continue;
    }
    if (src.state === 'disallowed') continue;
    const due = ownFeeds.filter((f) => f.next_poll_at <= now);
    // Заблокированный источник: одна редкая проверка по самой просроченной ленте.
    const feedRow = src.state === 'blocked' ? (due[0] ?? ownFeeds[0]) : due[0];
    plans.push({ adapter, src, kind: 'feed', order: feedRow ? feedRow.next_poll_at : now, feedRow, feeds: ownFeeds });
  }
  plans.sort((a, b) => a.order - b.order);

  const statements = [];
  const report = [];
  for (const plan of plans) {
    if (!budget.hasSubrequests(4)) break;
    const { adapter, src } = plan;
    let work = plan;
    if (plan.kind === 'feed' && typeof adapter.detailRequest === 'function' && src.state !== 'blocked') {
      const detail = await pendingDetail(db, adapter.id);
      if (detail) work = { ...plan, kind: 'detail', listing: detail, cost: 1 };
    }
    if (work.kind === 'feed') {
      if (!work.feedRow) continue;
      const feed = adapter.feeds.find((f) => feedId(adapter, f) === work.feedRow.id);
      if (!feed) continue;
      work = { ...work, feed };
      let request;
      try {
        request = pageRequestFor(adapter, feed, work.feedRow, src);
      } catch {
        // Курсор потерян: круг ленты начинается заново.
        statements.push(updateFeedStatement(db, work.feedRow.id, { page: 1, page_cursor: null, cycle_ids: null }));
        continue;
      }
      work.request = request;
      work.cost = request.purpose === 'state' ? 1 : feed.cost;
    }
    if (!budget.hasCpu(work.cost)) continue;
    if (!(await claimSite(db, adapter.id, now, SOURCE_MIN_GAP_MS))) continue;
    budget.hitSite(adapter.id);
    budget.use(1);
    budget.spendCpu(work.cost);

    let outcome;
    if (work.kind === 'robots') outcome = await doRobots(ctx, work);
    else if (work.kind === 'detail') outcome = await doDetail(ctx, work);
    else outcome = await doFeed(ctx, work);
    statements.push(...outcome.statements);
    report.push(outcome.report);
  }
  if (statements.length) await db.batch(statements);
  return report.length ? report : null;
}

function adapterState(src) {
  try {
    return src.adapter_state ? JSON.parse(src.adapter_state) : null;
  } catch {
    return null;
  }
}

function pageRequestFor(adapter, feed, feedRow, src) {
  return { purpose: 'page', ...adapter.pageRequest(feed, feedRow.page, feedRow.page_cursor, adapterState(src)) };
}

async function fetchSite(env, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(request.url, {
      headers: { 'User-Agent': userAgent(env), Accept: request.accept ?? 'text/html', 'Accept-Language': 'ru' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = request.readLimitBytes ? await readPrefix(res, request.readLimitBytes) : await res.text();
    return { status: res.status, statusText: res.statusText, headers: res.headers, text };
  } catch (err) {
    return { error: controller.signal.aborted ? 'тайм-аут 15 с' : `сетевая ошибка: ${String(err?.message ?? err).slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Начало ответа: чтение прекращается, как только набрано limit байт. */
async function readPrefix(res, limit) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

function blockedResponse(res) {
  if (res.status === 403 || res.status === 429) return true;
  if (res.headers?.get('cf-mitigated')) return true;
  const head = (res.text ?? '').slice(0, 4000);
  return BLOCK_MARKERS.some((m) => head.includes(m));
}

function httpText(res) {
  if (res.error) return res.error;
  return `${res.status} ${res.statusText || REASON_PHRASES[res.status] || ''}`.trim();
}

/** Поля источника после успешного запроса и сообщение «снова работает». */
async function onSuccess(ctx, src, extra = {}) {
  const { env, now } = ctx;
  const fields = {
    state: 'ok', consecutive_failures: 0, error_kind: null, error_text: null, failing_since: null,
    backoff_level: 0, next_check_at: null, last_ok_at: now, last_checked_at: now, ...extra,
  };
  if (src.alerted_at !== null) {
    await sendOwnerAlert(env, recoveryText(src.id, src.failing_since, now));
    ctx.budget.use(1);
    fields.alerted_at = null;
  }
  return fields;
}

/** Поля источника после сбоя; одно сообщение владельцу на сбой (sources.alerted_at). */
async function onFailure(ctx, src, kind, text) {
  const { env, now } = ctx;
  const failures = src.consecutive_failures + 1;
  const fields = {
    consecutive_failures: failures, error_kind: kind === 'disallowed' ? null : kind, error_text: text.slice(0, 200),
    failing_since: src.failing_since ?? now, last_checked_at: now,
  };
  let nextCheckHours = null;
  if (kind === 'blocked') {
    const level = Math.min(src.backoff_level, BLOCKED_BACKOFF_HOURS.length - 1);
    nextCheckHours = BLOCKED_BACKOFF_HOURS[level];
    Object.assign(fields, {
      state: 'blocked', backoff_level: Math.min(level + 1, BLOCKED_BACKOFF_HOURS.length - 1),
      next_check_at: now + nextCheckHours * HOUR,
    });
  } else if (kind === 'disallowed') {
    Object.assign(fields, { state: 'disallowed', robots_checked_at: now });
  } else {
    fields.state = src.state === 'blocked' ? 'blocked' : 'failing';
  }
  const alertNow = kind === 'blocked' || kind === 'disallowed' || failures >= FAILS_TO_ALERT;
  if (alertNow && src.alerted_at === null) {
    const row = { ...src, ...fields };
    const sent = await sendOwnerAlert(env, failureAlertText(row, { nextCheckHours: nextCheckHours ?? 1 }), src.id);
    ctx.budget.use(1);
    if (sent) fields.alerted_at = now;
  }
  return fields;
}

// ---------- robots.txt ----------

function urlsToCheck(adapter, src) {
  const state = adapterState(src) ?? { buildId: 'BUILD' };
  const urls = [];
  for (const feed of adapter.feeds) {
    urls.push(adapter.pageRequest(feed, 1, null, null).url);
    urls.push(adapter.pageRequest(feed, 1, null, state).url);
    if (feed.maxPages > 1) urls.push(adapter.pageRequest(feed, 2, 'CURSOR', state).url);
  }
  if (typeof adapter.detailRequest === 'function') urls.push(adapter.detailRequest('1').url);
  return [...new Set(urls)];
}

async function doRobots(ctx, { adapter, src }) {
  const { db, env, now } = ctx;
  const urls = urlsToCheck(adapter, src);
  const origin = new URL(urls[0]).origin;
  const res = await fetchSite(env, { url: `${origin}/robots.txt`, accept: 'text/plain' });
  const report = { source: adapter.id, kind: 'robots' };
  if (res.error || res.status >= 500) {
    // robots.txt недоступен: считаем, что всё закрыто, и пробуем позже (RFC 9309).
    const fields = await onFailure(ctx, src, 'http', `robots.txt: ${httpText(res)}`);
    fields.next_check_at = now + FAILING_RETRY_MS;
    return { statements: [updateSourceStatement(db, src.id, fields)], report: { ...report, result: 'unreachable' } };
  }
  const robots = res.status >= 400 ? null : parseRobots(res.text);
  const closed = urls.filter((u) => !isAllowed(robots, u, userAgent(env)));
  if (closed.length) {
    const path = new URL(closed[0]).pathname;
    const fields = await onFailure(ctx, src, 'disallowed', `закрыт ${decodeURI(path)}`);
    return { statements: [updateSourceStatement(db, src.id, fields)], report: { ...report, result: 'disallowed' } };
  }
  const fields = src.state === 'disallowed' ? await onSuccess(ctx, src, { robots_checked_at: now }) : { robots_checked_at: now };
  return { statements: [updateSourceStatement(db, src.id, fields)], report: { ...report, result: 'ok' } };
}

/**
 * Суточная сверка robots.txt (cron 30 0 * * *). Тик сверяет сам, только если эта не прошла (сайт был занят).
 * Заблокированный источник не трогается до своей проверки (sources.next_check_at).
 */
export async function robotsDailyStep(ctx) {
  const { db, now, budget } = ctx;
  const { sources } = await loadSourcesAndFeeds(db);
  const statements = [];
  const report = [];
  for (const adapter of ADAPTERS) {
    const src = sources.find((s) => s.id === adapter.id);
    if (!src || (src.next_check_at ?? 0) > now) continue;
    if (!budget.hasSubrequests(4)) break;
    if (!(await claimSite(db, adapter.id, now, SOURCE_MIN_GAP_MS))) {
      report.push({ source: adapter.id, kind: 'robots', result: 'busy' });
      continue;
    }
    budget.use(1);
    const outcome = await doRobots(ctx, { adapter, src });
    statements.push(...outcome.statements);
    report.push(outcome.report);
  }
  if (statements.length) await db.batch(statements);
  return report;
}

// ---------- карточка объявления ----------

async function doDetail(ctx, { adapter, src, listing }) {
  const { db, env } = ctx;
  const res = await fetchSite(env, { accept: 'text/html', ...adapter.detailRequest(listing.external_id) });
  const report = { source: adapter.id, kind: 'detail', id: listing.external_id };
  if (!res.error && blockedResponse(res) && res.status !== 200) {
    const fields = await onFailure(ctx, src, 'blocked', `${httpText(res)}, страница защиты от ботов`);
    return { statements: [updateSourceStatement(db, src.id, fields)], report: { ...report, result: 'blocked' } };
  }
  let coords = null;
  if (!res.error && res.status === 200) {
    try {
      coords = adapter.parseDetail(res.text)?.coords ?? null;
    } catch {
      coords = null;
    }
  }
  return {
    statements: [detailResultStatement(db, listing.id, coords)],
    report: { ...report, result: coords ? 'coords' : res.error ? 'error' : `no-coords ${res.status}` },
  };
}

// ---------- страница ленты ----------

function recognizedShare(items) {
  if (items.length === 0) return 1;
  const ok = items.filter((i) => i.price || i.priceUsd || i.priceByn || i.houseArea || i.plotArea || i.coords || i.place?.text);
  return ok.length / items.length;
}

async function doFeed(ctx, work) {
  const { db, env, now } = ctx;
  const { adapter, src, feed, feedRow, request } = work;
  const res = await fetchSite(env, request);
  const report = { source: adapter.id, feed: feedRow.id, page: feedRow.page };
  const statements = [];
  const fail = async (kind, text) => {
    const fields = await onFailure(ctx, src, kind, text);
    statements.push(updateSourceStatement(db, src.id, fields));
    if (kind !== 'blocked') statements.push(updateFeedStatement(db, feedRow.id, { next_poll_at: now + FAILING_RETRY_MS }));
    return { statements, report: { ...report, result: kind, error: fields.error_text } };
  };

  if (res.error) return fail('http', res.error);
  if (res.status === 404 && adapter.resetStateOn404 && request.purpose === 'page') {
    statements.push(updateSourceStatement(db, src.id, { adapter_state: null, last_checked_at: now }));
    return { statements, report: { ...report, result: 'state-reset' } };
  }
  if (res.status !== 200) {
    if (blockedResponse(res)) return fail('blocked', `${res.status}, страница защиты от ботов`);
    return fail('http', httpText(res));
  }

  if (request.purpose === 'state') {
    let state = null;
    try {
      state = adapter.parseState(res.text);
    } catch {
      state = null;
    }
    if (!state) return blockedResponse(res) ? fail('blocked', 'страница защиты от ботов') : fail('parse', 'не найдена версия сборки сайта');
    const fields = await onSuccess(ctx, src, { adapter_state: JSON.stringify(state) });
    statements.push(updateSourceStatement(db, src.id, fields));
    return { statements, report: { ...report, result: 'state' } };
  }

  let page;
  try {
    page = adapter.parsePage(res.text, { feed, page: feedRow.page });
  } catch {
    page = { items: [], looksValid: false };
  }
  const items = page.items ?? [];
  if (page.wrongSection) return fail('parse', 'сайт отдал другой раздел вместо продажи домов');
  if (items.length === 0 && (!page.looksValid || page.total > 0)) {
    if (blockedResponse(res)) return fail('blocked', '200, страница защиты от ботов');
    return fail('parse', 'на странице нет объявлений в ожидаемом виде');
  }
  if (recognizedShare(items) < 0.5) return fail('parse', 'у объявлений не распознаются цена, площади и место');

  const emptyStreak = items.length === 0 ? feedRow.empty_streak + 1 : 0;
  if (emptyStreak >= EMPTY_TO_FAIL) {
    statements.push(updateFeedStatement(db, feedRow.id, { empty_streak: emptyStreak }));
    return fail('empty', `лента пуста ${emptyStreak} раза подряд`);
  }

  const firstCycle = feedRow.prev_ids === null;
  const nonPaid = items.filter((i) => !i.paid).map((i) => i.externalId);
  const cycleIds = [...(feedRow.page > 1 && feedRow.cycle_ids ? JSON.parse(feedRow.cycle_ids) : []), ...nonPaid];
  const prev = new Set(feedRow.prev_ids ? JSON.parse(feedRow.prev_ids) : []);
  const last = nonPaid.at(-1);
  const cursorOk = adapter.paging !== 'cursor' || Boolean(page.nextCursor);
  const hasNext = feedRow.page < feed.maxPages && last !== undefined && !prev.has(last) && cursorOk;
  const feedFields = hasNext
    ? { page: feedRow.page + 1, page_cursor: page.nextCursor ?? null, cycle_ids: JSON.stringify(cycleIds), next_poll_at: now, empty_streak: emptyStreak }
    : {
        page: 1, page_cursor: null, cycle_ids: null, prev_ids: JSON.stringify(cycleIds.slice(0, PREV_IDS_MAX)),
        next_poll_at: now + adapter.intervalMin * MINUTE + Math.floor(Math.random() * FEED_JITTER_MS),
        last_ok_at: now, empty_streak: emptyStreak,
      };
  statements.push(updateFeedStatement(db, feedRow.id, feedFields));
  statements.push(updateSourceStatement(db, src.id, await onSuccess(ctx, src)));
  ctx.pages.push({ adapter, src, feedId: feedRow.id, items, firstCycle });
  return { statements, report: { ...report, result: 'ok', items: items.length, next: hasNext ? feedRow.page + 1 : null } };
}
