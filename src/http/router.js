import { handleWebhook } from '../telegram/webhook.js';
import { appPage, appScript } from './app-page.js';
import { handleApi } from './api.js';

/** @param {Request} request */
export async function handleFetch(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/telegram/webhook' && method === 'POST') return handleWebhook(request, env);
  if (pathname === '/app' && method === 'GET') return appPage();
  if (pathname === '/app/app.js' && method === 'GET') return appScript();
  if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(request, env, url);
  return new Response('Not found', { status: 404 });
}
