import { TICK } from '../config.js';

/**
 * Бюджет одного вызова: CPU-единицы (оценка по `cost`, ~1 мс), подзапросы (fetch и D1, batch = 1)
 * и не больше одного запроса к каждому сайту.
 */
export class Budget {
  constructor({ cpu = TICK.cpuBudget, subrequests = TICK.subrequestBudget } = {}) {
    this.cpuLimit = cpu;
    this.subrequestLimit = subrequests;
    this.cpuUsed = 0;
    this.subrequests = 0;
    this.sitesHit = new Set();
  }

  use(n = 1) {
    this.subrequests += n;
  }

  hasSubrequests(n = 1) {
    return this.subrequests + n <= this.subrequestLimit;
  }

  hasCpu(cost) {
    return this.cpuUsed + cost <= this.cpuLimit;
  }

  spendCpu(cost) {
    this.cpuUsed += cost;
  }

  /** Сайт свободен в этом тике: к нему ещё не обращались. */
  siteFree(sourceId) {
    return !this.sitesHit.has(sourceId);
  }

  hitSite(sourceId) {
    this.sitesHit.add(sourceId);
  }
}
