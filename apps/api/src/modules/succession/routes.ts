/**
 * R3-T05 继任管理接口（设计 §2.2；前缀 /api/tenant/succession）。装配位：登记权限对象、开关校验、准备度引用守卫与
 * 对外端口；路由随实现子 PR 追加，并按 F-039 格式在 policy.ts 登记声明、在
 * tests/acceptance/support/route-policy/required/succession.ts 登记必需义务。
 * A1（记录读侧）：#1 准备度选择器、#2 记录列表 / 详情。读入口每次请求按当前权限重验对象、范围与字段（AGENTS §10）。
 */
import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { validIsoDate } from '../org/read-model.js';
import { pageQuery, parseBody, revision, uuidParam, uuidQuery } from '../talent/http.js';
import { readinessPort } from '../talent-review/readiness-port.js';
import {
  requireFilterVisible,
  SUCCESSION_BASE,
  successionContext,
  type SuccessionContext,
  successionScope,
} from './access.js';
import './access.js';
import { CANDIDATE_DEFAULT, CANDIDATE_MAX, searchCandidates } from './candidates.js';
import { recordCreate, recordEnd, recordPatch, rejectImmutable } from './input.js';
import { projectSuccession, buildRecordViews } from './projection.js';
import './readiness-guard.js';
import {
  listRecordRows,
  loadRecordRow,
  RECORD_STATUS_FILTERS,
  type RecordFilter,
  type RecordStatusFilter,
  type RecordVisibility,
} from './record-read.js';
import './settings.js';
import { installSuccessionPorts } from './ports.js';
import { createRecord, deleteRecord, endRecords, updateRecord } from './record-write.js';
import {
  authorizeSuccessionResult,
  checkCandidateAccess,
  checkWriteAccess,
  runSuccessionCommand,
  type StoredResult,
  type WriteSpec,
} from './write-support.js';

const RECORDS = `${SUCCESSION_BASE}/records`;

export function registerSuccessionRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  installSuccessionPorts();

  // #1 准备度选择器：启用项的 id / code / name / color / sort（HR 读字典契约，设计 §8.3；只需 Record 查看权）
  router.get(`${SUCCESSION_BASE}/readiness`, async (c) => {
    const ctx = await successionContext(c, deps, 'record');
    const levels = await withTenant(deps.db, ctx.tenantId, (tx) => readinessPort.list(tx, ctx.tenantId));
    return c.json({
      items: levels
        .filter((level) => level.enabled)
        .map(({ id, code, name, color, sortNo }) => ({ id, code, name, color, sort: sortNo })),
    });
  });

  // #2 记录列表：缺省只列当前生效（DEC-343③），status 可切 ended / all；asOf 时点（§5.8）
  router.get(RECORDS, async (c) => {
    const ctx = await successionContext(c, deps, 'record');
    const page = pageQuery(c);
    const filter = await recordFilter(c, deps, ctx);
    const visibility = await recordVisibility(c, deps, ctx);
    const { rows, total } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const found = await listRecordRows(tx, visibility, filter, page);
      return { rows: await buildRecordViews(tx, ctx.tenantId, found.rows, visibility.asOf), total: found.total };
    });
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      total,
      asOf: visibility.asOf,
      hasDataPermission: visibility.scope.hasDataPermission,
      items: await projectSuccession(deps, ctx, 'record', rows),
    });
  });

  // #2 记录详情：范围外、SELF 隐藏、已删除、asOf 时尚未开始都与不存在同一个 404
  router.get(`${RECORDS}/:id`, async (c) => {
    const ctx = await successionContext(c, deps, 'record');
    const id = uuidParam(c);
    const visibility = await recordVisibility(c, deps, ctx);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const row = await loadRecordRow(tx, visibility, { status: 'all', id });
      return row
        ? { revision: row.revision, view: (await buildRecordViews(tx, ctx.tenantId, [row], visibility.asOf))[0]! }
        : undefined;
    });
    if (!found) throw new AppError('NOT_FOUND', '继任记录不存在');
    c.header('ETag', `"${found.revision}"`);
    return c.json((await projectSuccession(deps, ctx, 'record', [found.view]))[0]);
  });

  // #3 新增（含历史补录：给出结束时间即保存为已结束）；无 If-Match（新建），Idempotency-Key 必填
  router.post(RECORDS, async (c) => {
    const body = await parseBody(c, recordCreate);
    return writeRecord(c, deps, {
      operation: 'create',
      button: { code: 'create', level: 'list' },
      expectedRevision: 0,
      payload: body,
      input: body,
      status: 201,
      execute: (tx, ctx) => createRecord(tx, ctx, body),
    });
  });

  // #3a 继任者候选：全租户关键词搜索（DEC-308，不按员工范围裁剪）；持新增或编辑按钮之一即可
  router.get(`${SUCCESSION_BASE}/successor-candidates`, async (c) => {
    const ctx = await checkCandidateAccess(c, deps);
    const keyword = c.req.query('q')?.trim() ?? '';
    if (!keyword || keyword.length > 100) throw new AppError('VALIDATION_FAILED', 'q 必填，且不超过 100 个字符');
    const limit = candidateLimit(c.req.query('limit'));
    const today = tenantLocalDate(deps.clock(), ctx.timezone);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      searchCandidates(tx, ctx.tenantId, today, keyword, limit),
    );
    return c.json({ items });
  });

  // #4 编辑：白名单字段；endDate 置空 = 恢复生效；目标与继任者不可改（FIELD_IMMUTABLE，先于结构校验）
  router.put(`${RECORDS}/:id`, async (c) => {
    const id = uuidParam(c);
    const expectedRevision = revision(c);
    const raw: unknown = await c.req.json().catch(() => undefined);
    rejectImmutable(raw);
    const body = await parseBody(c, recordPatch);
    return writeRecord(c, deps, {
      operation: 'update',
      button: { code: 'update', level: 'detail' },
      expectedRevision,
      payload: body,
      input: { id, body },
      status: 200,
      execute: (tx, ctx) => updateRecord(tx, ctx, id, body),
    });
  });

  // #5 批量结束：整体成功或整体失败（≤ 200 条），逐条 expectedRevision
  router.post(`${RECORDS}/end`, async (c) => {
    const body = await parseBody(c, recordEnd);
    return writeRecord(c, deps, {
      operation: 'update',
      button: { code: 'end', level: 'list' },
      expectedRevision: 0,
      input: body,
      status: 200,
      execute: (tx, ctx) => endRecords(tx, ctx, body),
    });
  });

  // #6 软删除：回执 { id, deleted: true }；已删除的记录不再出现在任何读口
  router.delete(`${RECORDS}/:id`, async (c) => {
    const id = uuidParam(c);
    return writeRecord(c, deps, {
      operation: 'delete',
      button: { code: 'delete', level: 'detail' },
      expectedRevision: revision(c),
      input: { id },
      status: 200,
      execute: (tx, ctx) => deleteRecord(tx, ctx, id),
    });
  });
}

/**
 * 写入口共用出口（设计 §2.1）：命令前权限 → 命令协议（含事务内复核）→ authorizeSuccessionResult 返回前复核与投影。
 * 首次响应、直接重放、失败回查重放三条路径都走同一个 authorizeSuccessionResult。
 */
async function writeRecord(c: Context<TenantEnv>, deps: TenantRouteDeps, spec: WriteSpec): Promise<Response> {
  const ctx = await checkWriteAccess(c, deps, spec);
  const { status, result } = await runSuccessionCommand(c, deps, ctx, spec);
  return respond(c, deps, ctx, status, result);
}

async function respond(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  status: 200 | 201,
  result: StoredResult,
): Promise<Response> {
  const { items, revisions } = await authorizeSuccessionResult(deps, ctx, result);
  if (result.kind === 'receipt') return c.json({ id: result.ids[0], deleted: true }, status);
  if (result.kind === 'records') return c.json({ items }, status);
  c.header('ETag', `"${revisions.get(result.ids[0]!)}"`);
  return c.json(items[0], status);
}

function candidateLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return CANDIDATE_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > CANDIDATE_MAX) {
    throw new AppError('VALIDATION_FAILED', `limit 必须是 1～${CANDIDATE_MAX} 的整数`);
  }
  return value;
}

/** 列表筛选：值先校验再用；筛选字段须有查看权，否则不能借结果还原被裁掉的字段（403 FILTER_FIELD_HIDDEN）。 */
async function recordFilter(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
): Promise<RecordFilter> {
  const status = c.req.query('status');
  if (status !== undefined && !RECORD_STATUS_FILTERS.includes(status as RecordStatusFilter)) {
    throw new AppError('VALIDATION_FAILED', 'status 只能是 active、ended 或 all');
  }
  const type = c.req.query('successionType');
  if (type !== undefined && type !== 'org' && type !== 'position') {
    throw new AppError('VALIDATION_FAILED', 'successionType 只能是 org 或 position');
  }
  const filter: RecordFilter = {
    status: (status as RecordStatusFilter | undefined) ?? 'active',
    ...(type ? { successionType: type } : {}),
    ...optional('targetOrgId', uuidQuery(c, 'targetOrgId')),
    ...optional('targetPositionId', uuidQuery(c, 'targetPositionId')),
    ...optional('successorEmployeeId', uuidQuery(c, 'successorEmployeeId')),
  };
  const used: [string, unknown][] = [
    ['status', status],
    ['successionType', type],
    ['targetOrgId', filter.targetOrgId],
    ['targetPositionId', filter.targetPositionId],
    ['successorEmployeeId', filter.successorEmployeeId],
  ];
  for (const [field, value] of used) if (value !== undefined) await requireFilterVisible(deps, ctx, 'record', field);
  return filter;
}

const optional = <K extends string>(key: K, value: string | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };

/** 请求日与 asOf（缺省今天；晚于今天 400 AS_OF_IN_FUTURE，§5.8）、当前数据范围；两者都按本次请求解析。 */
async function recordVisibility(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
): Promise<RecordVisibility> {
  const today = tenantLocalDate(deps.clock(), ctx.timezone);
  const asOf = c.req.query('asOf') ?? today;
  if (!validIsoDate(asOf)) throw new AppError('VALIDATION_FAILED', '查询时点必须为合法日期');
  if (asOf > today) {
    throw new AppError('VALIDATION_FAILED', '查询时点不能晚于今天', { reason: 'AS_OF_IN_FUTURE' });
  }
  const scope = await successionScope(c, deps, ctx, 'record');
  return { tenantId: ctx.tenantId, userId: ctx.userId, today, asOf, scope };
}
