/**
 * @typedef {object} TelegramResult
 * @property {boolean} ok
 * @property {number} status          HTTP-статус ответа
 * @property {any} result
 * @property {number|null} errorCode
 * @property {string|null} description
 * @property {number|null} retryAfter  секунды из parameters.retry_after (429)
 */

/**
 * Вызов метода Bot API. Сетевая ошибка пробрасывается — её обрабатывает вызывающий.
 * @returns {Promise<TelegramResult>}
 */
export async function callTelegram(env, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return parseTelegramResponse(res.status, await res.text());
}

/** @returns {TelegramResult} */
export function parseTelegramResponse(status, text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, status, result: null, errorCode: status, description: `HTTP ${status}`, retryAfter: null };
  }
  const ok = data.ok === true;
  return {
    ok,
    status,
    result: ok ? data.result : null,
    errorCode: ok ? null : (data.error_code ?? status),
    description: data.description ?? null,
    retryAfter: data.parameters?.retry_after ?? null,
  };
}

export function sendMessage(env, chatId, text, extra = {}) {
  return callTelegram(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}
