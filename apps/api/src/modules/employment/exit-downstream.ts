/**
 * 撤销离职的下游数据清单与探针端口（R2-T03 设计 §7.4，DEC-275①，DM-R5 / 原站 W-517）。
 * 清单固定四类，顺序固定：合同、职责转交、离职交接、薪资档案；合同与职责转交按 exit_effects 真实历史填充，离职交接（BE-8）与
 * 薪资档案（复刻中尚无薪资模块）默认 not_connected 占位。其他台账效果（被作废的在途任职申请、被撤回的合同申请、挂回的未来调动、
 * 编制预减收回）作为 additional 附加项列在四类之后。探针按 kind 登记，后续模块（BE-8、兼职 PT6b、F-140 改期）用
 * registerDownstreamProbe 接入或替换，不改本文件；入口签名 probeDownstream 保持稳定。
 * 目标按查看人裁剪（trimDownstream）：合同按合同对象查看权，任职业务 / 职责转交下属按 DEC-177 可见范围，不可见的只计 hiddenCount。
 */
import { sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { disclose } from './exit-gate.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';
import { visibleEmploymentRecords } from './visibility.js';

export type DownstreamStatus = 'found' | 'none' | 'not_connected';

export interface DownstreamTarget {
  readonly type: string;
  readonly id: string;
  /** 目标所属员工（职责转交为下属）；可见性判定用，不一定回传。 */
  readonly employeeId?: string;
  readonly departmentId?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface DownstreamItem {
  readonly kind: string;
  readonly status: DownstreamStatus;
  readonly targets: readonly DownstreamTarget[];
  readonly hiddenCount: number;
}

export interface DownstreamInput {
  readonly employeeId: string;
  /** 被检查离职的最后工作日（最终值）；未生效的离职为计划值。 */
  readonly lastWorkDate: string | null;
  /** 被检查的离职业务（台账按它查）。 */
  readonly businessId: string;
}

/** 探针：返回该类目的状态与（未按查看人裁剪的）目标。 */
export interface DownstreamProbe {
  readonly kind: string;
  probe(
    tx: Tx,
    ctx: EmploymentContext,
    input: DownstreamInput,
  ): Promise<{ readonly status: DownstreamStatus; readonly targets: readonly DownstreamTarget[] }>;
}

/** 固定四类的顺序（DM-R5）。 */
export const FIXED_DOWNSTREAM_KINDS = ['contract', 'duty_transfer', 'handover', 'payroll'] as const;

interface EffectRow {
  readonly kind: string;
  readonly phase: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly detail: Record<string, unknown>;
  readonly departmentId: string | null;
  /** 目标记录当前是否在时间轴上（被摘下的调动撤销后挂回才在；已删除的不在）。 */
  readonly onTimeline: boolean;
}

/** 离职台账（只追加）的全部行，附目标业务最新载荷的部门（可见性判定用）。 */
async function effectsOf(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<EffectRow[]> {
  return rowsOf<EffectRow>(
    await tx.execute(sql`
    SELECT x.kind, x.phase, x.target_type AS "targetType", x.target_id::text AS "targetId", x.detail,
      (SELECT p.department_id::text FROM employment_payload_versions p
        WHERE p.tenant_id=x.tenant_id AND p.business_id=x.target_id
        ORDER BY p.version_no DESC LIMIT 1) AS "departmentId",
      EXISTS (SELECT 1 FROM employment_timeline tl WHERE tl.tenant_id=x.tenant_id AND tl.record_id=x.target_id) AS "onTimeline"
    FROM exit_effects x WHERE x.tenant_id=${ctx.tenantId} AND x.business_id=${businessId}::uuid
    ORDER BY x.created_at, x.id`),
  );
}

const ledgerTargets = (rows: readonly EffectRow[], kinds: readonly string[]): DownstreamTarget[] =>
  rows
    .filter((row) => kinds.includes(row.kind) && row.targetId)
    .map((row) => ({
      type: row.targetType,
      id: row.targetId!,
      ...(row.targetType === 'transfer-linkage-item' && typeof row.detail.subordinateId === 'string'
        ? { employeeId: row.detail.subordinateId }
        : {}),
      ...(row.departmentId ? { departmentId: row.departmentId } : {}),
      detail: { effect: row.kind, ...row.detail },
    }));

const ledgerProbe = (kind: string, effects: readonly string[]): DownstreamProbe => ({
  kind,
  probe: async (tx, ctx, input) => {
    const targets = ledgerTargets(await effectsOf(tx, ctx, input.businessId), effects);
    return { status: targets.length ? 'found' : 'none', targets };
  },
});

const notConnected = (kind: string): DownstreamProbe => ({
  kind,
  probe: async () => ({ status: 'not_connected', targets: [] }),
});

const probes = new Map<string, DownstreamProbe>([
  ['contract', ledgerProbe('contract', ['contract_terminated', 'contract_deleted'])],
  ['duty_transfer', ledgerProbe('duty_transfer', ['duty_transferred', 'duty_failed'])],
  ['handover', notConnected('handover')],
  ['payroll', notConnected('payroll')],
]);

/** 登记 / 替换某一类目的探针；固定四类保持原位，新类目追加在其后。 */
export function registerDownstreamProbe(probe: DownstreamProbe): void {
  probes.set(probe.kind, probe);
}

/** 附加项：台账里其他效果，按“撤销后对 HR 意味着什么”分三种动作。 */
const ADDITIONAL = [
  { effect: 'application_voided', action: 'reinitiate' },
  { effect: 'contract_request_withdrawn', action: 'reinitiate' },
  { effect: 'future_transfer_detached', action: 'reattached' },
  { effect: 'establishment_pre_released', action: 'restored' },
] as const;

export interface DownstreamAdditional extends Omit<DownstreamItem, 'status'> {
  /** reinitiate：保持作废 / 撤回，需重新发起；reattached：已按原窗口挂回；restored：占用已收回。 */
  readonly action: (typeof ADDITIONAL)[number]['action'];
}

export interface Downstream {
  readonly items: DownstreamItem[];
  readonly additional: DownstreamAdditional[];
}

/** 撤销清单（未按查看人裁剪）：四类固定 + 已登记的其他探针 + 附加项。 */
export async function probeDownstream(tx: Tx, ctx: EmploymentContext, input: DownstreamInput): Promise<Downstream> {
  const order = [
    ...FIXED_DOWNSTREAM_KINDS,
    ...[...probes.keys()].filter((kind) => !FIXED_DOWNSTREAM_KINDS.includes(kind as never)),
  ];
  const items: DownstreamItem[] = [];
  for (const kind of order) {
    const result = await probes.get(kind)!.probe(tx, ctx, input);
    items.push({ kind, status: result.status, targets: result.targets, hiddenCount: 0 });
  }
  const effects = await effectsOf(tx, ctx, input.businessId);
  const additional: DownstreamAdditional[] = [];
  for (const { effect, action } of ADDITIONAL) {
    // “已挂回”只报实际回到时间轴的调动；撤销前已被 HR 删除的不报（P2-1）
    const rows = effects.filter(
      (row) => row.kind === effect && (effect !== 'future_transfer_detached' || row.onTimeline),
    );
    if (!rows.length) continue;
    additional.push({ kind: effect, action, targets: ledgerTargets(rows, [effect]), hiddenCount: 0 });
  }
  return { items, additional };
}

// ---- 按查看人裁剪 ----------------------------------------------------------------------------------------------

async function allowed(ctx: EmploymentContext, resource: string) {
  return ctx.authorize ? Boolean(await ctx.authorize({ ...ctx, action: 'object.view', resource })) : true;
}

/** 每个目标是否对查看人可见：合同类按合同对象查看权，任职业务按 DEC-177，职责转交按下属可见，编制按编制对象查看权。 */
async function visibleMap(tx: Tx, ctx: EmploymentContext, targets: readonly DownstreamTarget[], employeeId: string) {
  const visible = new Map<string, boolean>();
  const key = (target: DownstreamTarget) => `${target.type}:${target.id}`;
  const contract = await allowed(ctx, CONTRACT_OBJECT);
  const capacity = await allowed(ctx, MODULE_OBJECTS.establishment.code);
  const businesses = targets.filter(
    (target) => target.type === 'employment-business' || target.type === 'employment-record',
  );
  const shown = businesses.length
    ? await disclose(
        tx,
        ctx,
        employeeId,
        businesses.map((target) => ({ id: target.id, effectiveDate: '', departmentId: target.departmentId ?? null })),
      )
    : { items: [] };
  const shownBusiness = new Set(shown.items.map((item) => item.businessId));
  const linked = targets.filter((target) => target.type === 'transfer-linkage-item');
  const linkedVisible = linked.length
    ? await visibleEmploymentRecords(
        tx,
        ctx.tenantId,
        ctx.scope,
        linked.map((target) => ({ employeeId: target.employeeId ?? employeeId, departmentId: null, creatorId: null })),
      )
    : [];
  for (const target of targets) {
    if (target.type === 'contract' || target.type === 'contract-request') visible.set(key(target), contract);
    else if (target.type === 'establishment-capacity') visible.set(key(target), capacity);
    else if (target.type === 'transfer-linkage-item')
      visible.set(key(target), linkedVisible[linked.indexOf(target)] ?? false);
    else visible.set(key(target), shownBusiness.has(target.id));
  }
  return { visible, key };
}

/** 响应前按查看人裁剪：不可见的目标移除并计入 hiddenCount；可见目标不回传 employeeId / departmentId 等判定用字段。 */
export async function trimDownstream(
  tx: Tx,
  ctx: EmploymentContext,
  downstream: Downstream,
  employeeId: string,
): Promise<Downstream> {
  const all = [...downstream.items, ...downstream.additional].flatMap((entry) => entry.targets);
  const { visible, key } = await visibleMap(tx, ctx, all, employeeId);
  const trim = <T extends { targets: readonly DownstreamTarget[] }>(entry: T) => {
    const shown = entry.targets.filter((target) => visible.get(key(target)));
    return {
      ...entry,
      targets: shown.map(({ type, id, detail }) => ({ type, id, ...(detail ? { detail } : {}) })),
      hiddenCount: entry.targets.length - shown.length,
    };
  };
  return { items: downstream.items.map(trim) as DownstreamItem[], additional: downstream.additional.map(trim) };
}
