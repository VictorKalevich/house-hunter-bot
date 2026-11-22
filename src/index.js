import { handleFetch } from './http/router.js';
import { runTick } from './jobs/tick.js';
import { runDaily } from './jobs/daily.js';

const DAILY_CRON = '30 0 * * *';

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const now = controller.scheduledTime;
    if (controller.cron === DAILY_CRON) await runDaily(env, { now });
    else await runTick(env, { now });
  },
};
