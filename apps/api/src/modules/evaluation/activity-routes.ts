/**
 * 评定活动接口（B5，设计 §3.2、§5.1、§5.3）：`/api/tenant/evaluation/activities`。带所属组织（按所属组织 ∪ 所属人，无向下公开，
 * DEC-324②）与嵌套环节；负责人经人员引用出口呈现（范围内 姓名 + 工号，范围外只有姓名，无权只剩 ID），所以单独成文件、不进通用注册器
 * （通用接口的权限事实里不会多出员工信息查看权与各类被引用对象的查看权）。
 * 写命令走 `runWrite` / `runDelete`：权限、范围与引用访问（类型 / 周期 / 评价表 / 类别 / 级别的查看权与范围、负责人的人员范围与字段）
 * 都在命令事务内由 `ledgerExit` 之前的 `before` 重新解析（首次、直接重放、失败后回查同一出口，DEC-388①）。
 * 服务端在载荷之外自动改写的字段：无（跨级限制新建缺省取 1 是系统缺省值，不是对已有值的改动；状态 draft、报名数 0 由系统写）。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { ACTIVITY_STATUSES } from '@italent/domain';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  evaluationContext,
  evaluationScope,
  evaluationWriteContext,
  listEnvelope,
  requireFilterVisible,
  requireVisible,
  scopePredicate,
  viewableFields,
} from './access.js';
import { resolveActivityRefs } from './activity-refs.js';
import * as activities from './activity-service.js';
import { registerActivityUsage } from './activity-usage.js';
import * as input from './input.js';
import { personRefAccess, personRefAccessInTransaction, type PersonRefAccess } from './person-refs.js';
import * as read from './read-model.js';
import { EV_BASE, presenter, runDelete, runWrite, type WriteRefs, writeContext } from './route-support.js';
import { rowAccess } from './store.js';

const OBJECT = 'evaluationActivity';
const PATH = `${EV_BASE}/activities`;

/** 引用访问在命令事务内解析；响应的负责人按最近一次解析的人员访问整形。 */
const REFS: WriteRefs = {
  resolve: async (deps, ctx, tx) => ({
    persons: await personRefAccessInTransaction(deps, ctx, tx),
    activities: await resolveActivityRefs(deps, ctx, tx),
  }),
  shape: (tx, write, views) => activities.presentActivities(tx, write.tenantId, write.persons!, views),
};

/** 删除只回显被删活动：不需要各类被引用对象的访问，只解析负责人的人员访问。 */
const REMOVAL_REFS: WriteRefs = {
  resolve: async (deps, ctx, tx) => ({ persons: await personRefAccessInTransaction(deps, ctx, tx) }),
  shape: REFS.shape,
};

/** 列表的状态筛选：值非法 400；筛选字段须有查看权（requireFilterVisible）。 */
function statusFilter(raw: string | undefined) {
  if (raw === undefined) return undefined;
  if (!(ACTIVITY_STATUSES as readonly string[]).includes(raw)) {
    throw new AppError('VALIDATION_FAILED', '状态取值不合法', { reason: 'STATUS_INVALID' });
  }
  return raw;
}

export function registerActivityRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerActivityUsage();
  const present = presenter(deps, OBJECT);
  /** 读出行 → 挂环节 → 负责人整形（字段权限裁剪之前）。 */
  const shapeRows = async (tx: Tx, tenantId: string, access: PersonRefAccess, rows: Record<string, unknown>[]) =>
    activities.presentActivities(tx, tenantId, access, await activities.withChains(tx, tenantId, rows));

  router.get(PATH, async (c) => {
    const ctx = await evaluationContext(c, deps, OBJECT);
    const page = pageQuery(c);
    const scope = await evaluationScope(c, deps, ctx, OBJECT);
    const fields = await viewableFields(deps, ctx, OBJECT);
    const status = statusFilter(c.req.query('status'));
    if (status !== undefined) requireFilterVisible(fields, 'status');
    const filter = status === undefined ? sql`true` : sql`t.status = ${status}`;
    const access = await personRefAccess(c, deps, ctx);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const rows = await read.listRows(
        tx,
        ctx.tenantId,
        OBJECT,
        scopePredicate(scope, OBJECT),
        page,
        filter,
        read.orderBy(OBJECT, fields),
      );
      return shapeRows(tx, ctx.tenantId, access, rows);
    });
    return c.json({ ...listEnvelope(page, scope, OBJECT), items: await present(ctx, items) });
  });

  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationContext(c, deps, OBJECT);
    const id = uuidParam(c);
    const scope = await evaluationScope(c, deps, ctx, OBJECT);
    const access = await personRefAccess(c, deps, ctx);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireVisible((await rowAccess(tx, ctx, scope, OBJECT, id)).visible, OBJECT);
      const row = (await read.loadRow(tx, ctx.tenantId, OBJECT, id))!;
      return (await shapeRows(tx, ctx.tenantId, access, [row]))[0]!;
    });
    c.header('ETag', `"${found.revision}"`);
    return c.json((await present(ctx, [found]))[0]);
  });

  router.post(PATH, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, input.activityCreate);
    await checkWriteFields(deps, ctx, OBJECT, 'create', body);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, OBJECT));
    return runWrite(c, deps, w, OBJECT, body, 201, (tx, x) => activities.createActivity(tx, x, body), REFS);
  });

  router.patch(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.activityPatch);
    await checkWriteFields(deps, ctx, OBJECT, 'update', body);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, OBJECT));
    return runWrite(c, deps, w, OBJECT, body, 200, (tx, x) => activities.updateActivity(tx, x, id, body), REFS);
  });

  router.delete(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'delete', revision(c));
    const id = uuidParam(c);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, OBJECT));
    return runDelete(c, deps, w, OBJECT, id, (tx, x) => activities.deleteActivity(tx, x, id), REMOVAL_REFS);
  });
}
