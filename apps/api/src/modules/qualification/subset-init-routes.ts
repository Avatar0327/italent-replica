/**
 * 任职资格子集初始化路由（R3-T02 C1-5，设计 §4.1 / §5.1 点名的批量命令；业务规则见 subset-init.ts）：
 * POST /api/tenant/qualification/subsets/initialize  { employeeIds: [≤500] }  → 200 { items: 逐名员工回执 }
 * - 授权：与 HR 在人员子集里逐个新增任职资格同一道门——TenantBase.Qualification 的新增数据操作 + 列表层“新增”按钮，
 *   人员范围用同一个 personScope 谓词（范围外与不存在同一回执，不透露是否存在）；不另造功能点；
 * - 幂等：Idempotency-Key 必带，同键同内容返回首次回执；事务内先按当前权限复核（guard.before），撤权后首次执行整体回滚；
 * - 重放：回执里的员工按**当前**人员范围重新裁剪——撤权或员工已不在范围内，重放时该员工显示为 EMPLOYEE_NOT_FOUND，
 *   不再带出记录明细（AGENTS §10 权限）。
 */
import { withTenant } from '@italent/db';
import { SUBSETS } from '@italent/domain';
import type { Hono } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { access, authorizeTx } from '../personnel/access.js';
import { safe } from '../personnel/http.js';
import { parseBody } from '../talent/http.js';
import * as input from './input.js';
import { QL_BASE } from './route-support.js';
import { employeesInScope, initializeQualificationSubsets, type InitResult } from './subset-init.js';

export function registerSubsetInitialize(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${QL_BASE}/subsets/initialize`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, SUBSETS.qualification.objectCode, 'create', {}, 'create');
      const body = await parseBody(c, input.subsetInitialize);
      const result = await runCommand(deps.db, ctx, {
        id: c.req.header('idempotency-key'),
        fingerprint: { method: c.req.method, path: c.req.path, input: body },
        guard: { before: (tx) => authorizeTx(tx, deps, ctx, 'create', {}, 'create') },
        execute: async (tx, commandId) => ({
          status: 200,
          body: await initializeQualificationSubsets(tx, { ...ctx, commandId }, body.employeeIds),
        }),
      });
      return c.json(await redactOutOfScope(deps, ctx, result.body as InitResult), 200);
    }),
  );
}

/** 回执按当前范围再裁一遍：首次执行刚判过范围，结果不变；幂等重放时撤权 / 离开范围的员工不再带出明细。 */
async function redactOutOfScope(
  deps: TenantRouteDeps,
  ctx: Parameters<typeof employeesInScope>[1],
  result: InitResult,
): Promise<InitResult> {
  const visible = await withTenant(deps.db, ctx.tenantId, (tx) =>
    employeesInScope(
      tx,
      ctx,
      result.items.filter((item) => item.outcome === 'processed').map((item) => item.employeeId),
    ),
  );
  return {
    items: result.items.map((item) =>
      item.outcome === 'processed' && !visible.has(item.employeeId)
        ? { employeeId: item.employeeId, outcome: 'skipped' as const, reason: 'EMPLOYEE_NOT_FOUND' as const }
        : item,
    ),
  };
}
