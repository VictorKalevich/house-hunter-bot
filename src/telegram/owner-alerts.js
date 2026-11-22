// Сообщения владельцу о сбоях источников (contracts/telegram-bot.md, FR-020, US5).
import { durationText, minskDayTime } from '../time.js';
import { SOURCE_TITLES } from '../sources/titles.js';
import { sendMessage } from './api.js';
import { escapeHtml } from './html.js';

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/**
 * @param {{id: string, state: string, error_kind: string|null, error_text: string|null, failing_since: number|null,
 *   consecutive_failures: number}} source
 * @param {{nextCheckHours?: number}} ctx
 */
export function failureAlertText(source, { nextCheckHours = 1 } = {}) {
  const title = SOURCE_TITLES[source.id] ?? source.id;
  const since = minskDayTime(source.failing_since ?? Date.now());
  const why = source.error_text ?? 'неизвестная ошибка';
  if (source.state === 'disallowed') {
    return `${title}: адреса лент закрыты в robots.txt с ${since} (${why}). Бот перестал опрашивать сайт и проверяет robots.txt раз в сутки.`;
  }
  if (source.error_kind === 'blocked') {
    return `${title} отказал боту с ${since} (${why}). Обходить защиту бот не будет; следующая проверка через ${nextCheckHours} ч, дальше реже.`;
  }
  if (source.error_kind === 'parse' || source.error_kind === 'empty') {
    return `${title} перестал распознаваться с ${since}: ${why}. Нужна правка разбора.`;
  }
  const n = source.consecutive_failures;
  return `${title} не отвечает с ${since}: ${why} (${n} ${plural(n, 'проверка', 'проверки', 'проверок')} подряд). Остальные сайты работают.`;
}

export function recoveryText(sourceId, failingSince, now) {
  const title = SOURCE_TITLES[sourceId] ?? sourceId;
  return failingSince ? `${title} снова работает. Сбой длился ${durationText(now - failingSince)}.` : `${title} снова работает.`;
}

export async function sendOwnerAlert(env, text, sourceId = null) {
  if (!env.OWNER_TELEGRAM_ID) return false;
  const extra = sourceId
    ? { reply_markup: { inline_keyboard: [[{ text: 'Проверить сейчас', callback_data: `probe:${sourceId}` }]] } }
    : {};
  try {
    const r = await sendMessage(env, env.OWNER_TELEGRAM_ID, escapeHtml(text), extra);
    return r.ok;
  } catch {
    return false;
  }
}
