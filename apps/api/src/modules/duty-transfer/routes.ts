/**
 * 职责转交菜单路由（R2-T09a；DEC-602② / DEC-726 / F-408）。对象 TenantBase.DutyTransferCommon，按被转交人的数据范围
 * （DT-R9）：范围外的人菜单 404、记录不列。写入口走命令台账（runCommand），守卫在事务内按当前范围复核被转交人
 * （首次与幂等重放都经过，#199）；改写的组织 / 任职字段另按真实对象授权（transfer/linkage/access.ts）。
 * - GET  /people/:id/duties：被转交人当前职责与未完成的转交（菜单回填）；
 * - POST /people/:id/check：确认信息（只读，不进台账）；
 * - POST /people/:id：提交（立即 / 指定日期；覆盖、撤回带记录 revision）；
 * - GET  /records：转交记录三页签；GET /departed：检查离职退休人员。
 */
import { withTenant, type Tx } from '@italent/db';
import {
  DUTY_TRANSFER_FIELDS,
  DUTY_TRANSFER_OBJECT,
  DUTY_TRANSFER_SET_RECEIVER_BUTTON,
  dutyPendingHint,
  tenantLocalDate,
} from '@italent/domain';
import { sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { rowsOf } from '../employment/read-model.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
  scopeSql,
  type ModuleScope,
} from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { button, objectContext, requestScope, writeFields } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { currentDuties, departedWithDuties, pendingRecords } from './duties.js';
import { listDutyRecords, type DutyRecordView, type RecordTab } from './records.js';
import { checkMenuTransfer, submitMenuTransfer, type MenuSubmitInput } from './service.js';

export const DUTY_TRANSFER_BASE = '/api/tenant/duty-transfers';
const OBJECT = DUTY_TRANSFER_OBJECT;

registerPersonScopedObject(OBJECT);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const itemSchema = z.union([
  z.strictObject({
    dutyType: z.literal(1),
    orgId: uuid,
    orgRole: z.enum(['person_in_charge', 'shop_owner', 'hrbp']),
    receiverId: uuid.nullable(),
    revision: z.number().int().positive().optional(),
  }),
  z.strictObject({
    dutyType: z.literal(2),
    subordinateId: uuid,
    relation: z.enum(['direct', 'dotted']),
    receiverId: uuid.nullable(),
    revision: z.number().int().positive().optional(),
  }),
]);
// 批量上限（AGENTS §10）：一人承担的职责条数在原站页面一次展示，200 条足够且有界。
const submitSchema = z.strictObject({
  timing: z.enum(['immediate', 'scheduled']),
  transferDate: isoDate.optional(),
  items: z.array(itemSchema).min(1).max(200),
});

function submitInput(body: z.infer<typeof submitSchema>): MenuSubmitInput {
  return {
    ...body,
    items: body.items.map((item) =>
      item.dutyType === 1 ? { ...item, subordinateId: null, relation: null } : { ...item, orgId: null, orgRole: null },
    ),
  };
}

/** 被转交人在操作人的菜单范围内（SQL 判定，含按汇报关系 / 组织动态解析的人员范围）。 */
async function personVisible(tx: Tx, tenantId: string, scope: ModuleScope, employeeId: string) {
  const [row] = rowsOf<{ ok: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM employment_employees e
      WHERE e.tenant_id=${tenantId} AND e.id=${employeeId}::uuid AND ${scopeSql(scope, { person: sql`e.id` })}) AS ok`),
  );
  return row?.ok === true;
}

async function requireVisiblePerson(tx: Tx, tenantId: string, scope: ModuleScope, employeeId: string) {
  if (!(await personVisible(tx, tenantId, scope, employeeId))) throw new AppError('NOT_FOUND', '员工不存在');
}

/** 命令事务内按当前权限重解析范围（不沿用入口的旧范围）。 */
async function scopeInTransaction(tx: Tx, deps: TenantRouteDeps, ctx: ScopeBusinessContext) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  return resolveModuleScopeInTransaction(bound, ctx, tx, OBJECT);
}

/** 只裁对象字段（DUTY_TRANSFER_FIELDS）；id、failure 是记录标识与执行回执，不是可配置字段。 */
async function trimRecords(deps: TenantRouteDeps, ctx: ScopeBusinessContext, rows: readonly DutyRecordView[]) {
  const fields = await getModuleViewableFields(deps, ctx, OBJECT);
  if (fields === undefined) return rows;
  const hidden = DUTY_TRANSFER_FIELDS.filter((field) => !fields.has(field));
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !hidden.includes(key as never))));
}

/** 菜单回填：被转交人当前职责，逐条带上未完成的转交（再次选同一被转交人时回填接收人与日期）。 */
async function dutyMenu(tx: Tx, tenantId: string, employeeId: string, today: string) {
  const duties = await currentDuties(tx, tenantId, employeeId, today);
  const pending = await pendingRecords(tx, tenantId, employeeId);
  const items = duties.map(({ holderId: _holder, ...duty }) => {
    const record = pending.get(duty.key);
    const fill = record && {
      recordId: record.id,
      revision: record.revision,
      receiverId: record.receiverId,
      transferDate: record.transferDate,
    };
    return { ...duty, pending: fill ?? null };
  });
  const dates = items.flatMap((item) => (item.pending ? [item.pending.transferDate] : []));
  const hint = dutyPendingHint(items.length, dates);
  return { employeeId, total: items.length, pendingCount: dates.length, hint, items };
}

export function registerDutyTransferRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${DUTY_TRANSFER_BASE}/people/:id/duties`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'view');
    const employeeId = uuidParam(c);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await requireVisiblePerson(tx, ctx.tenantId, scope, employeeId);
      return dutyMenu(tx, ctx.tenantId, employeeId, today);
    });
    return c.json(result);
  });

  router.post(`${DUTY_TRANSFER_BASE}/people/:id/check`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'create');
    const employeeId = uuidParam(c);
    const input = submitInput(await parseBody(c, submitSchema));
    await button(deps, ctx, OBJECT, DUTY_TRANSFER_SET_RECEIVER_BUTTON, 'list');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await requireVisiblePerson(tx, ctx.tenantId, scope, employeeId);
      return checkMenuTransfer(tx, { ...ctx }, employeeId, input);
    });
    return c.json(result);
  });

  router.post(`${DUTY_TRANSFER_BASE}/people/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'create', revision(c));
    requireNew(ctx);
    const employeeId = uuidParam(c);
    const body = await parseBody(c, submitSchema);
    const input = submitInput(body);
    await writeFields(deps, ctx, OBJECT, 'create', { receiverId: null, transferDate: null });
    await button(deps, ctx, OBJECT, DUTY_TRANSFER_SET_RECEIVER_BUTTON, 'list');
    const guard = async (tx: Tx) =>
      requireVisiblePerson(tx, ctx.tenantId, await scopeInTransaction(tx, deps, ctx), employeeId);
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, body },
      guard: { before: guard, replayed: guard },
      execute: async (tx, commandId) => {
        const authorize = authorizeInTransaction(deps.authorize, tx);
        const employmentScope = await resolveModuleScopeInTransaction(
          { ...deps, authorize },
          ctx,
          tx,
          EMPLOYMENT_OBJECT,
        );
        const access = { authorize, employmentScope };
        const view = await submitMenuTransfer(tx, { ...ctx, commandId }, employeeId, input, access);
        return { status: 200, body: view };
      },
    });
    const view = result.body as { batchId: string; count: number; records: DutyRecordView[] };
    return c.json({ ...view, records: await trimRecords(deps, ctx, view.records) }, 200);
  });

  router.get(`${DUTY_TRANSFER_BASE}/records`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'view');
    const filter = recordFilter(c);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const visible: SQL = scopeSql(scope, { person: sql`u."employeeId"::uuid` });
    const page = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listDutyRecords(tx, ctx.tenantId, today, filter, visible),
    );
    return c.json({ total: page.total, items: await trimRecords(deps, ctx, page.items) });
  });

  router.get(`${DUTY_TRANSFER_BASE}/departed`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'view');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      departedWithDuties(tx, ctx.tenantId, today, scopeSql(scope, { person: sql`t.employee_id` })),
    );
    return c.json({ total: items.length, items });
  });
}

const optionalInt = (c: Context, name: string, allowed: readonly number[]) => {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!allowed.includes(value)) throw new AppError('VALIDATION_FAILED', `${name} 取值不合法`);
  return value;
};

function recordFilter(c: Context) {
  const tab = (c.req.query('tab') ?? 'all') as RecordTab;
  if (!['all', 'pending', 'completed'].includes(tab)) throw new AppError('VALIDATION_FAILED', 'tab 取值不合法');
  const employeeId = c.req.query('employeeId') || undefined;
  if (employeeId !== undefined && !uuid.safeParse(employeeId).success)
    throw new AppError('VALIDATION_FAILED', 'employeeId 不合法');
  const { limit, offset } = pageQuery(c);
  return {
    tab,
    employeeId,
    status: optionalInt(c, 'status', [0, 1, 2, 3]),
    source: optionalInt(c, 'source', [1, 2, 3, 4]),
    limit,
    offset,
  };
}
