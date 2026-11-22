// Текстовые модули: правило `rules` типа Text в wrangler.jsonc (research.md R8).
import html from '../app/index.html';
import script from '../app/app.js.txt';
import tokens from '../../design-system/tokens.css';
import components from '../../design-system/components.css';

const page = html.replace('/*@design-system*/', () => `${tokens}\n${components}`);

export function appPage() {
  return new Response(page, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

export function appScript() {
  return new Response(script, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
