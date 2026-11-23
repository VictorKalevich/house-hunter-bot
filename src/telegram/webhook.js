// contracts/telegram-bot.md: webhook, доступ, главное меню, действия владельца.
import { getUser, listUsers, recordDenial, revokeUser, touchUser, upsertOwner } from '../db/users.js';
import { createInvite, inviteLink, useInvite } from '../db/invites.js';
import { setMark } from '../db/marks.js';
import { listSources, probeSource } from '../db/sources.js';
import { markKeyboard } from '../match/format.js';
import { SOURCE_TITLES } from '../sources/titles.js';
import { minskDate, minskTime, minskDayTime } from '../time.js';
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage } from './api.js';
import { escapeHtml } from './html.js';

export const TEXT = {
  menu:
    'Я присылаю новые объявления о домах с участками с kufar.by, realt.by, domovita.by и moyareklama.by.\n' +
    'Создайте поиск — и я напишу, как только появится подходящий дом.',
  attribution: 'Данные карт © участники OpenStreetMap (ODbL) · маршруты © openrouteservice by HeiGIT',
  welcome: 'Добро пожаловать! Владелец пригласил вас в бота.',
  revoked: 'Доступ к боту закрыт владельцем.',
  inviteUsed: 'Это приглашение уже использовано или недействительно. Попросите у владельца новую ссылку.',
  inviteOnly: 'Этот бот работает только по приглашению. Попросите ссылку у владельца.',
  noAccess: 'Нет доступа',
};

// Кнопки отметок под сообщениями об объявлениях (specs/003-listing-likes/contracts/telegram-bot.md).
const MARK_ACTIONS = {
  lk: { mark: 'like', text: 'Добавлено в понравившиеся' },
  ul: { mark: null, only: 'like', text: 'Убрано из понравившихся' },
  hd: { mark: 'hide', text: 'Скрыто — больше не покажу' },
  uh: { mark: null, only: 'hide', text: 'Возвращено' },
};
const MARK_REFUSALS = {
  not_found: 'Объявление уже удалено из бота',
  like_limit: 'В понравившихся уже 100 объявлений — уберите лишние',
};
const MARK_DATA = /^(lk|ul|hd|uh):(\d{1,15})$/;

const USERS_PAGE = 10;
const INVITE_START = /^\/start(?:@\w+)?\s+inv_([A-Za-z0-9_-]{22})\s*$/;

export async function handleWebhook(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  try {
    await processUpdate(update, env, Date.now());
  } catch (err) {
    console.error(JSON.stringify({ event: 'webhook_error', update_id: update?.update_id, message: String(err?.message ?? err) }));
  }
  return new Response('OK');
}

export async function processUpdate(update, env, now) {
  const db = env.DB;
  if (update.message) {
    const msg = update.message;
    if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
    const access = await resolveAccess(db, env, msg.from, msg.text ?? '', now);
    if (access.deny) {
      await sendMessage(env, msg.chat.id, escapeHtml(access.deny));
      return;
    }
    await sendMenu(env, msg.chat.id, access.user, access.welcomed);
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const access = await resolveAccess(db, env, cq.from, '', now);
    if (access.deny) {
      await answer(env, cq.id, access.deny);
      return;
    }
    await handleCallback(env, db, cq, access.user, now);
  }
}

async function resolveAccess(db, env, from, text, now) {
  if (env.OWNER_TELEGRAM_ID && String(from.id) === String(env.OWNER_TELEGRAM_ID)) {
    return { user: await upsertOwner(db, from, now) };
  }
  const user = await getUser(db, from.id);
  if (user) {
    if (user.access !== 'active') return { deny: TEXT.revoked };
    return { user: await touchUser(db, user, from) };
  }
  const invite = INVITE_START.exec(text.trim());
  if (invite) {
    if (await useInvite(db, invite[1], from, now)) return { user: await getUser(db, from.id), welcomed: true };
    const again = await getUser(db, from.id);
    if (again?.access === 'active') return { user: again };
    await recordDenial(db, from.id, now);
    return { deny: TEXT.inviteUsed };
  }
  await recordDenial(db, from.id, now);
  return { deny: TEXT.inviteOnly };
}

export function menuKeyboard(env, user) {
  const base = String(env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  const rows = [
    [{ text: 'Новый поиск', web_app: { url: `${base}/app#/search/new` } }],
    [{ text: 'Мои поиски', web_app: { url: `${base}/app#/` } }],
    [{ text: 'Понравившиеся', web_app: { url: `${base}/app#/liked` } }],
  ];
  if (user.role === 'owner') {
    rows.push([
      { text: 'Пригласить', callback_data: 'inv:new' },
      { text: 'Пользователи', callback_data: 'users:0' },
    ]);
    rows.push([{ text: 'Источники', callback_data: 'src' }]);
  }
  return { inline_keyboard: rows };
}

async function sendMenu(env, chatId, user, welcomed) {
  const text = `${welcomed ? `${TEXT.welcome}\n\n` : ''}${TEXT.menu}\n\n<i>${escapeHtml(TEXT.attribution)}</i>`;
  await sendMessage(env, chatId, text, {
    reply_markup: menuKeyboard(env, user),
    link_preview_options: { is_disabled: true },
  });
}

function answer(env, callbackId, text) {
  return answerCallbackQuery(env, callbackId, text);
}

/** Строка — сразу после записи; затем перерисовка кнопок, если сообщение доступно (date = 0 — недоступно). */
async function handleMark(env, db, cq, user, action, listingId, now) {
  const marked = await setMark(db, user.telegram_id, listingId, action.mark, now, { only: action.only ?? null });
  if (marked.error) {
    await answerCallbackQuery(env, cq.id, MARK_REFUSALS[marked.error], { showAlert: true });
    return;
  }
  await answerCallbackQuery(env, cq.id, action.text);
  const msg = cq.message;
  if (!msg?.date || !msg.chat) return;
  const res = await editMessageReplyMarkup(env, msg.chat.id, msg.message_id, markKeyboard({ id: listingId, url: marked.url }, marked.mark));
  if (!res.ok && !/message is not modified/i.test(res.description ?? '')) {
    console.error(JSON.stringify({ event: 'mark_markup_failed', code: res.errorCode, description: res.description }));
  }
}

async function handleCallback(env, db, cq, user, now) {
  const data = String(cq.data ?? '');
  const chatId = cq.message?.chat?.id ?? cq.from.id;
  const mark = MARK_DATA.exec(data);
  if (mark) {
    await handleMark(env, db, cq, user, MARK_ACTIONS[mark[1]], Number(mark[2]), now);
    return;
  }
  if (user.role !== 'owner') {
    await answer(env, cq.id, TEXT.noAccess);
    return;
  }

  if (data === 'inv:new') {
    const token = await createInvite(db, user.telegram_id, now);
    const link = inviteLink(env.BOT_USERNAME, token);
    await sendMessage(
      env,
      chatId,
      `Ссылка-приглашение для одного человека: ${escapeHtml(link)}\nПерешлите её тому, кого хотите пустить.`,
      { link_preview_options: { is_disabled: true } },
    );
    await answer(env, cq.id);
    return;
  }

  let m = /^users:(\d{1,6})$/.exec(data);
  if (m) {
    await sendUsers(env, db, chatId, Number(m[1]));
    await answer(env, cq.id);
    return;
  }

  m = /^rv:(\d{1,20})$/.exec(data);
  if (m) {
    const target = await getUser(db, Number(m[1]));
    if (!target || target.role === 'owner') {
      await answer(env, cq.id, target ? 'Себе закрыть доступ нельзя.' : 'Пользователь не найден.');
      return;
    }
    await sendMessage(env, chatId, `Закрыть доступ: ${escapeHtml(target.first_name)}? Поиски этого человека остановятся.`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Да, закрыть', callback_data: `rv!:${target.telegram_id}` },
          { text: 'Отмена', callback_data: 'cancel' },
        ]],
      },
    });
    await answer(env, cq.id);
    return;
  }

  m = /^rv!:(\d{1,20})$/.exec(data);
  if (m) {
    const id = Number(m[1]);
    if (id === user.telegram_id) {
      await answer(env, cq.id, 'Себе закрыть доступ нельзя.');
      return;
    }
    const target = await getUser(db, id);
    if (!target) {
      await answer(env, cq.id, 'Пользователь не найден.');
      return;
    }
    await revokeUser(db, id, now);
    await sendMessage(env, chatId, 'Доступ закрыт.');
    await answer(env, cq.id);
    return;
  }

  if (data === 'src') {
    await sendSources(env, db, chatId);
    await answer(env, cq.id);
    return;
  }

  m = /^probe:([a-z]+)$/.exec(data);
  if (m && SOURCE_TITLES[m[1]]) {
    await probeSource(db, m[1], now);
    await answer(env, cq.id, 'Проверю в течение минуты.');
    return;
  }

  if (data === 'cancel') {
    await answer(env, cq.id, 'Отменено');
    return;
  }
  await answer(env, cq.id);
}

async function sendUsers(env, db, chatId, offset) {
  const { items, more } = await listUsers(db, offset, USERS_PAGE);
  if (items.length === 0) {
    await sendMessage(env, chatId, 'Пользователей нет.');
    return;
  }
  const lines = items.map((u) => {
    const name = escapeHtml(u.first_name) + (u.username ? ` (@${escapeHtml(u.username)})` : '');
    const note = u.role === 'owner' ? ' — владелец' : u.access === 'revoked' ? ' — доступ закрыт' : '';
    return `${name} — с ${minskDate(u.created_at)}${note}`;
  });
  const keyboard = items
    .filter((u) => u.role !== 'owner' && u.access === 'active')
    .map((u) => [{ text: `Закрыть доступ: ${u.first_name}`.slice(0, 60), callback_data: `rv:${u.telegram_id}` }]);
  if (more) keyboard.push([{ text: 'Дальше', callback_data: `users:${offset + USERS_PAGE}` }]);
  await sendMessage(env, chatId, lines.join('\n'), { reply_markup: { inline_keyboard: keyboard } });
}

const STATE_TEXT = {
  ok: 'работает',
  failing: 'сбой',
  blocked: 'отказал боту',
  disallowed: 'закрыт в robots.txt',
};

export function sourceStatusLine(row) {
  const title = SOURCE_TITLES[row.id] ?? row.id;
  if (row.state === 'ok') {
    return `${title} — работает${row.last_ok_at ? `, проверен ${minskTime(row.last_ok_at)}` : ', ещё не проверялся'}`;
  }
  const since = row.failing_since ? ` с ${minskDayTime(row.failing_since)}` : '';
  const why = row.error_text ? `: ${row.error_text}` : '';
  return `${title} — ${STATE_TEXT[row.state] ?? row.state}${since}${why}`;
}

async function sendSources(env, db, chatId) {
  const rows = await listSources(db);
  const text = rows.length ? rows.map((r) => escapeHtml(sourceStatusLine(r))).join('\n') : 'Источники ещё не опрашивались.';
  const keyboard = rows
    .filter((r) => r.state !== 'ok')
    .map((r) => [{ text: `Проверить сейчас: ${SOURCE_TITLES[r.id] ?? r.id}`, callback_data: `probe:${r.id}` }]);
  await sendMessage(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}
