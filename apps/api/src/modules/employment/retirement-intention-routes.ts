/**
 * R2-T04 意向退休日期申请路由（5d2，设计 §11 / §12.1；挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）：
 * 创建 / 修改 / 提交 / 撤回 / 列表 / 详情。HR 入口：授权 = 任职记录对象的数据操作 + 详情级按钮 Employment.RetireIntention + 字段权；
 * 读用 DEC-177 可见口径（分页前过滤），写用申请行自己的三个坐标（requireIntentionWriteScope，DEC-193），命令内按当前授权复核（#199）。
 * 自助入口随 F-020，服务已按 initiation 设计，这里不挂路由。
 */
import { withTenant } from '@italent/db';
import { RETIREMENT_INTENTION_STATES } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { foreignVisibility } from '../approval/foreign-fields.js';
import type { FieldAccess } from '../approval/context.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import {
  commandContext,
  jsonBody,
  pageQuery,
  readContext,
  readPageContext,
  revision,
  runWrite,
  scopedGuard,
  trimEmploymentResponse,
  uuidParam,
  type EmploymentContext,
} from './context.js';
import { parse } from './entry-routes.js';
import { lockIntentionRows, requireIntentionRight } from './retirement-intention-access.js';
import {
  createIntention,
  parseIntentionCreate,
  parseIntentionPatch,
  submitIntention,
  updateIntention,
  withdrawIntention,
} from './retirement-intention.js';
import { intentionView, listIntentions, loadVisibleIntention } from './retirement-intention-store.js';

type C = Context<TenantEnv>;

const listQuery = z.strictObject({
  employeeId: z.uuid().optional(),
  status: z.enum(RETIREMENT_INTENTION_STATES).optional(),
});

/** 提交时审批中心按候选审批人的字段查看权做盲审（DEC-058）：与 approval/routes.ts 的 fieldAccess 同口径（各模块自带）。 */
function approvalFields(deps: TenantRouteDeps, ctx: EmploymentContext): FieldAccess {
  return {
    viewable: (tx, userId, objectCode) =>
      getModuleViewableFieldsInTransaction(deps, { ...ctx, userId }, objectCode, tx),
    foreignVisible: (tx, userId, field) => foreignVisibility(deps, { ...ctx, userId }, tx)(field),
  };
}

/** 提交 / 撤回不接受客户端参数：带任何字段一律 400。 */
async function emptyBody(c: C): Promise<void> {
  if (c.req.header('content-type')) parse(z.strictObject({}), await jsonBody(c));
}

/**
 * 命令事务内的当前权限复核（首次、同键重放与失败回查同一出口）：先取员工锁 → 申请行锁，再在持锁状态下解析当前授权，
 * 与审批中心撤回 / 重提共用同一个入口 requireIntentionRight（DEC-431①）：对象写权 + 实际字段编辑权 + Employment.RetireIntention
 * + 申请行三坐标写范围。创建没有申请行：写范围由服务按即将写入的快照部门 / 员工 / 本单发起人判（§11.1）。
 */
function intentionGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  target: { readonly employeeId: string } | { readonly intentionId: string },
  fields: Readonly<Record<string, unknown>>,
) {
  return scopedGuard({
    before: async (tx) => {
      const row = await lockIntentionRows(tx, ctx, target);
      const scoped = await commandContext(tx, deps, ctx);
      await requireIntentionRight(tx, scoped, { operation: 'employeeId' in target ? 'create' : 'update', fields, row });
    },
  });
}

const definedKeys = (input: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

export function registerRetirementIntentionRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerWrites(router, deps);
  registerReads(router, deps);
}

function registerWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 创建草稿：If-Match = 员工 revision；员工须当前在职，同员工无未办结申请，日期晚于今天且落在弹性范围内
  router.post('/retirement-intentions/employees/:id', async (c) => {
    const id = uuidParam(c);
    // 不带员工 ID：员工主档创建人不是本单的范围坐标（§11.1 creatorId = 本单发起人），范围由命令内三坐标授权判定
    const ctx = await readContext(c, deps, 'object.create', revision(c));
    const input = parseIntentionCreate(await jsonBody(c));
    return runWrite(
      c,
      deps,
      ctx,
      { id, input },
      async (tx, context) => ({ status: 201, body: intentionView(await createIntention(tx, context, id, input)) }),
      { guard: intentionGuard(deps, ctx, { employeeId: id }, definedKeys(input)) },
    );
  });
  router.patch('/retirement-intentions/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const patch = parseIntentionPatch(await jsonBody(c));
    return runWrite(
      c,
      deps,
      ctx,
      { id, patch },
      async (tx, context) => ({ status: 200, body: intentionView(await updateIntention(tx, context, id, patch)) }),
      { guard: intentionGuard(deps, ctx, { intentionId: id }, definedKeys(patch)) },
    );
  });
  for (const action of ['submit', 'withdraw'] as const)
    router.post(`/retirement-intentions/:id/${action}`, async (c) => {
      const id = uuidParam(c);
      const ctx = await readContext(c, deps, 'object.update', revision(c));
      await emptyBody(c);
      return runWrite(
        c,
        deps,
        ctx,
        { id, action },
        async (tx, context) => ({
          status: 200,
          body: intentionView(
            action === 'submit'
              ? await submitIntention(tx, context, id, approvalFields(deps, ctx))
              : await withdrawIntention(tx, context, id),
          ),
        }),
        { guard: intentionGuard(deps, ctx, { intentionId: id }, {}) },
      );
    });
}

function registerReads(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 列表：DEC-177 可见口径在分页前过滤，total 与本页同一范围；筛选参数严格校验
  router.get('/retirement-intentions', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const query = Object.entries(c.req.query()).filter(([key]) => !['page', 'pageSize'].includes(key));
    const parsed = parse(listQuery, Object.fromEntries(query));
    const filter = { ...(parsed.employeeId ? { employeeId: parsed.employeeId } : {}) };
    const page = pageQuery(c);
    const { items, total } = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listIntentions(tx, ctx, { ...filter, ...(parsed.status ? { state: parsed.status } : {}) }, page),
    );
    return c.json({
      items: await trimEmploymentResponse(deps, ctx, items.map(intentionView)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    });
  });
  // 详情：看不见与不存在同一个 404「意向退休申请不存在」
  router.get('/retirement-intentions/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const row = await withTenant(deps.db, ctx.tenantId, (tx) => loadVisibleIntention(tx, ctx, id));
    return c.json(await trimEmploymentResponse(deps, ctx, intentionView(row)));
  });
}
