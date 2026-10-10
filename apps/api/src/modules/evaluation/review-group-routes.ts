/**
 * 评审组接口（B3，设计 §3.2、§5.1、§8）：`/api/tenant/evaluation/review-groups`。带所属组织（按所属组织 ∪ 所属人，无向下公开，
 * DEC-324②）与嵌套成员，成员是人员引用（人员引用出口 person-refs.ts，DEC-331① / DEC-339②），所以单独成文件、不进通用注册器：
 * 通用注册器的接口不查员工信息，不能让它们的权限事实多出员工信息查看权。
 * 员工信息的访问（查看权 / 范围 / 字段）每次请求（含幂等重放）按当前权限重新解析，随写命令上下文进事务。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  type EvaluationContext,
  evaluationContext,
  evaluationScope,
  evaluationWriteContext,
  listEnvelope,
  requireFilterVisible,
  requireVisible,
  scopePredicate,
  viewableFields,
} from './access.js';
import * as input from './input.js';
import { type PersonRefAccess, personRefAccess, personRefAccessInTransaction } from './person-refs.js';
import * as read from './read-model.js';
import * as groups from './review-group-service.js';
import { EV_BASE, presenter, type WriteRefs, runWrite, writeContext } from './route-support.js';
import { rowAccess } from './store.js';

const OBJECT = 'reviewGroup';
const PATH = `${EV_BASE}/review-groups`;

/** 成员的人员引用：写命令在事务内重新解析员工信息的访问；响应按解析结果整形（person-refs.ts）。 */
const REFS: WriteRefs = {
  resolve: async (deps, ctx, tx) => ({ persons: await personRefAccessInTransaction(deps, ctx, tx) }),
  shape: (tx, write, views) => groups.presentGroups(tx, write.tenantId, write.persons!, views),
};

export function registerReviewGroupRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  const present = presenter(deps, OBJECT);
  /** 读出行 → 挂成员 → 成员的人员引用整形（字段权限裁剪之前）。 */
  const shapeRows = async (tx: Tx, tenantId: string, persons: PersonRefAccess, rows: Record<string, unknown>[]) =>
    groups.presentGroups(tx, tenantId, persons, await groups.withMembers(tx, tenantId, rows));
  /** 写命令的上下文：员工信息的访问由 route-support 在命令事务内（含重放与失败后回查）按当前授权解析，这里不预先解析。 */
  const writing = async (c: Context<TenantEnv>, ctx: EvaluationContext) =>
    writeContext(ctx, await evaluationScope(c, deps, ctx, OBJECT));

  router.get(PATH, async (c) => {
    const ctx = await evaluationContext(c, deps, OBJECT);
    const page = pageQuery(c);
    const scope = await evaluationScope(c, deps, ctx, OBJECT);
    const fields = await viewableFields(deps, ctx, OBJECT);
    const enabled = booleanQuery(c, 'enabled');
    if (enabled !== undefined) requireFilterVisible(fields, 'enabled');
    const filter = enabled === undefined ? sql`true` : sql`t.enabled = ${enabled}`;
    const persons = await personRefAccess(c, deps, ctx);
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
      return shapeRows(tx, ctx.tenantId, persons, rows);
    });
    return c.json({ ...listEnvelope(page, scope, OBJECT), items: await present(ctx, items) });
  });

  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationContext(c, deps, OBJECT);
    const id = uuidParam(c);
    const scope = await evaluationScope(c, deps, ctx, OBJECT);
    const persons = await personRefAccess(c, deps, ctx);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireVisible((await rowAccess(tx, ctx, scope, OBJECT, id)).visible, OBJECT);
      const row = (await read.loadRow(tx, ctx.tenantId, OBJECT, id))!;
      return (await shapeRows(tx, ctx.tenantId, persons, [row]))[0]!;
    });
    c.header('ETag', `"${found.revision}"`);
    return c.json((await present(ctx, [found]))[0]);
  });

  router.post(PATH, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, input.reviewGroupCreate);
    await checkWriteFields(deps, ctx, OBJECT, 'create', body);
    const w = await writing(c, ctx);
    return runWrite(c, deps, w, OBJECT, body, 201, (tx, x) => groups.createReviewGroup(tx, x, body), REFS);
  });

  router.patch(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.reviewGroupPatch);
    await checkWriteFields(deps, ctx, OBJECT, 'update', body);
    const w = await writing(c, ctx);
    return runWrite(c, deps, w, OBJECT, body, 200, (tx, x) => groups.updateReviewGroup(tx, x, id, body), REFS);
  });
}
