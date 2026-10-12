/** C2-1b：静态实际路由清单中的评定写入口须可追到周期守卫；未知路径默认要求守卫。 */
import ts from 'typescript';
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
      .filter(() => !hasAwaitedCycleGuard(closure(route)))
      .map((method) => `${method} ${route.exactPath ?? '<未解析路径>'}`),
  );
}

/** AST 只承认等待完成的调用，注释、字符串与单纯提及函数名不能成为守卫证据。 */
function hasAwaitedCycleGuard(source: string): boolean {
  const file = ts.createSourceFile('cycle-route.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    const expression = ts.isAwaitExpression(node) || ts.isReturnStatement(node) ? node.expression : undefined;
    if (
      expression &&
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'assertCycleActive'
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
