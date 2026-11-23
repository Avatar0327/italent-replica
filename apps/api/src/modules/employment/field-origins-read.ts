/**
 * 字段来源只读接口的出数（F-036 设计 §4.9）：把详情路由算出的 `shown` 与来源台账折叠结果拼成行。
 * 字段集合与值只取自 `shown`（不另开读数据的通道）；来源只是附在其上的说明。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { effectiveOrigin, type FieldOriginKind } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { transferBusinessContext } from '../transfer/service.js';
import { loadFieldOrigins } from './field-origin-store.js';
import { loadEmploymentBusiness, rowsOf } from './read-model.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';

export interface FieldOriginView {
  readonly kind: FieldOriginKind;
  readonly label: string | null;
  readonly at: string;
  readonly sourceBusinessId: string | null;
  readonly reason: string | null;
}

export interface FieldOriginRowView {
  readonly fieldCode: string;
  readonly value: unknown;
  readonly origin: FieldOriginView | null;
  readonly policy: string | null;
  readonly pending: boolean;
  readonly suspended: boolean;
}

/** 展示名：取设计 §4.2 “来源种类”列；策略行 none / retain 与判定行 fallback / restore 不单独展示。 */
const ORIGIN_LABELS: Readonly<Record<FieldOriginKind, string | null>> = {
  inherit: '继承',
  deferred: '延迟继承',
  resolved: '延迟继承（落地）',
  copy: 'HR / 系统保存',
  'hr-input': 'HR / 系统保存',
  'system-input': 'HR / 系统保存',
  'employee-input': '员工本次输入',
  'approval-edit': '审批节点编辑',
  'hr-record': 'HR 补录',
  'forward-update': '向后更新',
  derive: '向后更新（引用派生）',
  'derive-edit': '向后更新（引用派生）',
  'sequence-sync': '序列同步',
  'status-propagate': '状态传播',
  none: null,
  retain: null,
  fallback: null,
  restore: null,
};

type Shown = {
  readonly fields?: Record<string, unknown>;
  readonly customFields?: Record<string, unknown>;
  readonly employeeStatus?: unknown;
  readonly entryStatus?: unknown;
};

/** `shown` 里出现的字段：预置 `preset:<名>`、自定义 `custom:<ID>`、状态 `status:<名>`。 */
function shownEntries(shown: Shown) {
  const entries: { fieldCode: string; value: unknown }[] = [];
  for (const [name, value] of Object.entries(shown.fields ?? {})) entries.push({ fieldCode: `preset:${name}`, value });
  for (const [id, value] of Object.entries(shown.customFields ?? {}))
    entries.push({ fieldCode: `custom:${id}`, value });
  for (const name of ['employeeStatus', 'entryStatus'] as const)
    if (name in shown) entries.push({ fieldCode: `status:${name}`, value: shown[name] });
  return entries;
}

/** 冻结分支：已办审批人读办理当时的内容，不读来源台账，不带任何现值信息。 */
export function frozenOriginRows(shown: Shown): FieldOriginRowView[] {
  return shownEntries(shown).map((entry) => ({
    ...entry,
    origin: null,
    policy: null,
    pending: false,
    suspended: false,
  }));
}

/** 业务读取门禁，详情、来源接口与来源业务 ID 的裁剪共用这一个入口（DEC-431①）：不可读抛 NOT_FOUND / FORBIDDEN。 */
async function readGate(tx: Tx, ctx: EmploymentContext, id: string, asOf: string, frozen: boolean) {
  // 同单调动先过团队门禁（经理只读本团队）；通过调动例外时不再套数据范围，与 GET /businesses/:id 一致。
  const gated = frozen ? ctx : await transferBusinessContext(tx, ctx, id);
  const scope = frozen || gated.transferTarget ? undefined : gated.scope;
  const value = await loadEmploymentBusiness(tx, gated.tenantId, id, asOf, scope);
  if (!value) throw new AppError('NOT_FOUND', '任职业务不存在');
  return { value, ctx: gated };
}

const isDenied = (error: unknown) =>
  error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN');

const requireRead = (deps: TenantRouteDeps, ctx: EmploymentContext, employeeId: string) =>
  requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: employeeId });

/** 最新载荷版本是否已是记录快照：延迟继承字段已随快照物化（S3 落地 / 顺延），不再待解析。 */
async function latestIsRecordSnapshot(tx: Tx, tenantId: string, businessId: string) {
  const [row] = rowsOf<{ snapshot: boolean }>(
    await tx.execute(sql`SELECT is_record_snapshot AS snapshot FROM employment_payload_versions
      WHERE tenant_id = ${tenantId}::uuid AND business_id = ${businessId}::uuid
      ORDER BY version_no DESC LIMIT 1`),
  );
  return row?.snapshot === true;
}

type OriginStates = Awaited<ReturnType<typeof loadFieldOrigins>>;

export interface LocatedOrigins {
  readonly value: EmploymentBusiness;
  readonly ctx: EmploymentContext;
  readonly states: OriginStates;
  readonly landed: boolean;
}

/**
 * 定位业务并取来源台账：值与台账在同一个只读 repeatable read 快照里读（并发 PATCH 不会让旧值配上新来源）。
 * 授权器可能自己开事务（PGlite 单连接会死锁），所以对象权限在快照事务之外判；不可读一律抛 NOT_FOUND / FORBIDDEN。
 */
export async function locateOrigins(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  asOf: string,
  frozen: boolean,
): Promise<LocatedOrigins> {
  const snapshot = await withTenant(
    deps.db,
    ctx.tenantId,
    async (tx) => ({
      ...(await readGate(tx, ctx, id, asOf, frozen)),
      // 冻结分支不读来源台账
      states: frozen ? (new Map() as OriginStates) : await loadFieldOrigins(tx, ctx, id),
      landed: await latestIsRecordSnapshot(tx, ctx.tenantId, id),
    }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  await requireRead(deps, snapshot.ctx, snapshot.value.employeeId);
  return snapshot;
}

/** 来源业务对操作人可读才给出 ID：逐个过同一个读取门禁（含调动团队门禁与创建人坐标）和对象权限，拒绝只清 ID。 */
async function readableSources(deps: TenantRouteDeps, ctx: EmploymentContext, ids: readonly string[], asOf: string) {
  const found = await withTenant(
    deps.db,
    ctx.tenantId,
    async (tx) => {
      const rows: { id: string; employeeId: string }[] = [];
      for (const id of ids) {
        try {
          rows.push({ id, employeeId: (await readGate(tx, ctx, id, asOf, false)).value.employeeId });
        } catch (error) {
          if (!isDenied(error)) throw error;
        }
      }
      return rows;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const readable = new Set<string>();
  for (const row of found) {
    try {
      await requireRead(deps, ctx, row.employeeId);
      readable.add(row.id);
    } catch (error) {
      if (!isDenied(error)) throw error;
    }
  }
  return readable;
}

/** 现值分支：用快照里折叠好的台账状态给 `shown` 的每个字段附来源。只读，不写任何表。 */
export async function liveOriginRows(
  deps: TenantRouteDeps,
  located: LocatedOrigins,
  asOf: string,
  shown: Shown,
): Promise<FieldOriginRowView[]> {
  const entries = shownEntries(shown);
  const writers = new Map(
    entries.map((entry) => [entry.fieldCode, effectiveOrigin(located.states.get(entry.fieldCode)).lastWriter]),
  );
  const sourceIds = [
    ...new Set([...writers.values()].flatMap((row) => (row?.sourceBusinessId ? [row.sourceBusinessId] : []))),
  ];
  const readable = sourceIds.length ? await readableSources(deps, located.ctx, sourceIds, asOf) : new Set<string>();
  return entries.map((entry) => {
    const state = located.states.get(entry.fieldCode);
    const writer = writers.get(entry.fieldCode) ?? null;
    return {
      ...entry,
      origin: writer && {
        kind: writer.originKind,
        label: ORIGIN_LABELS[writer.originKind],
        at: writer.createdAt.toISOString(),
        sourceBusinessId:
          writer.sourceBusinessId && readable.has(writer.sourceBusinessId) ? writer.sourceBusinessId : null,
        reason: writer.reason,
      },
      policy: state?.policy ?? null,
      // 已随记录快照物化的延迟字段不再待解析；resolved 写入归 S6，本片不写
      pending: state?.policy === 'deferred' && writer === null && !located.landed,
      suspended: (state?.suspended.size ?? 0) > 0,
    };
  });
}
