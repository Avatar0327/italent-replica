/** C2-1b：静态实际路由清单中的评定写入口须可追到周期守卫；未知路径默认要求守卫。 */
import type { StaticRegistration } from './support/route-policy/scan.js';

const BASE = '/api/tenant/evaluation';
// 只豁免已交付的配置 / 活动级入口；新建嵌套命令不会因为活动前缀而漏掉。
const CONFIG_WRITES = new Set([
  ...[
    'activity-types',
    'activity-cycles',
    'general-score-items',
    'review-groups',
    'evaluation-forms',
    'activities',
  ].flatMap((path) => [`POST ${BASE}/${path}`, `PATCH ${BASE}/${path}/:id`, `DELETE ${BASE}/${path}/:id`]),
  `POST ${BASE}/activities/:id/publish`,
  `POST ${BASE}/activities/:id/unpublish`,
]);
export function missingCycleGuards(
  routes: readonly StaticRegistration[],
  closure: (route: StaticRegistration) => string,
) {
  return routes.flatMap((route) =>
    route.methods
      .filter((method) => !['GET', 'HEAD', 'OPTIONS'].includes(method))
      .filter((method) => !CONFIG_WRITES.has(`${method} ${route.exactPath}`))
      .filter(() => !/\b(?:await\s+|return\s+)assertCycleActive\s*\(/.test(closure(route)))
      .map((method) => `${method} ${route.exactPath ?? '<未解析路径>'}`),
  );
}
