// Реестр адаптеров (contracts/source-adapter.md).
import kufar from './kufar.js';
import realt from './realt.js';
import domovita from './domovita.js';
import moyareklama from './moyareklama.js';

export const ADAPTERS = [kufar, realt, domovita, moyareklama];

/** @type {Record<string, any>} */
export const SOURCES = Object.fromEntries(ADAPTERS.map((a) => [a.id, a]));

export function feedId(adapter, feed) {
  return feed.key.startsWith(`${adapter.id}:`) ? feed.key : `${adapter.id}:${feed.key}`;
}

/** Лента по id строки feeds. */
export function findFeed(id) {
  for (const adapter of ADAPTERS) {
    for (const feed of adapter.feeds) {
      if (feedId(adapter, feed) === id) return { adapter, feed };
    }
  }
  return null;
}
