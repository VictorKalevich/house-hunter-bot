// Разбор robots.txt (RFC 9309): группы User-agent, Allow/Disallow с `*` и `$`, побеждает самое длинное правило,
// при равной длине — Allow. Пути сравниваются в раскодированном виде: сайты пишут кириллицу и так, и через %XX.

function decodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** @returns {{groups: Array<{agents: string[], rules: Array<{allow: boolean, path: string, re: RegExp}>}>}} */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((key === 'allow' || key === 'disallow') && current && value) {
      const path = decodePath(value);
      current.rules.push({ allow: key === 'allow', path, re: patternToRegExp(path) });
    }
  }
  return { groups };
}

function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

/** Группа для бота: та, чей User-agent входит в наш токен продукта, иначе `*`. */
function groupFor(robots, userAgent) {
  const token = String(userAgent ?? '').split('/')[0].trim().toLowerCase();
  const own = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && token && token.includes(a)));
  if (own.length) return own.flatMap((g) => g.rules);
  return robots.groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
}

/**
 * @param {{groups: Array}} robots результат parseRobots; null — robots.txt нет (4xx), всё разрешено
 * @param {string} url
 */
export function isAllowed(robots, url, userAgent) {
  if (!robots) return true;
  const u = new URL(url);
  const path = decodePath(u.pathname + u.search);
  if (path === '/robots.txt') return true;
  let best = null;
  for (const rule of groupFor(robots, userAgent)) {
    if (!rule.re.test(path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}
