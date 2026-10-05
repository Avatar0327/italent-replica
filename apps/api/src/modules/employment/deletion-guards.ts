/**
 * R1-T11 删除已生效任职前的守卫（`08` §6、REQ-TRF-005 R4）。原站删除只回退时间轴、不拦截也不回滚联动
 * （`07` A11、W-013、W-424）；复刻有意从严：
 * - DEC-126：该员工其后有在途申请（审批中 / 审批通过未生效）时拒绝删除，提示先撤销或驳回；
 * - DEC-012 / DEC-172：调动联动修改过的对象仍保持联动结果时拒绝删除，提示列出这些对象，调整后才能删除。
 * 联动只看“当前仍在”的结果，HR 已手工调整的不再拦截。合同变更、职责转交归 R1-T10：它在装配时用
 * registerDeletionLinkageProbe 登记各自的探针，本模块不读合同 / 职责表。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentDepartmentDisable } from '../org/employment-validity.js';
import { assertEstablishmentCapacity } from './activation-checks.js';
import { auditEmployment, employmentRecordVisibleTo, requireLinkedEmploymentRecord } from './context.js';
import { loadEmploymentRecord } from './read-model.js';
import { rowsOf } from './record-store.js';
import { validateEmploymentReferences } from './references.js';
import type { ReportingWindow } from './reporting-cycle.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

/** 一项仍在的联动结果；label 原样拼进提示，其余字段作为机读详情返回。 */
export interface LinkedChange {
  readonly kind: string;
  readonly label: string;
  readonly [detail: string]: unknown;
}

/** 在删除命令的事务内调用，只读；返回空数组表示没有仍在的联动。 */
export type DeletionLinkageProbe = (
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
) => Promise<readonly LinkedChange[]>;

const MAX_LISTED = 50;
const probes = new Map<string, DeletionLinkageProbe>([['organization', organizationLinkage]]);

/** 同名重复登记时替换，便于装配幂等。TODO(R1-T10)：登记合同变更、职责转交两个探针。 */
export function registerDeletionLinkageProbe(name: string, probe: DeletionLinkageProbe): void {
  probes.set(name, probe);
}

interface PendingApplication {
  readonly id: string;
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly status: string;
}

const PENDING_MESSAGE = '该员工有在途申请，请先撤销或驳回后再删除';

/**
 * DEC-126 的拒绝。默认详情只给件数（PR #73 第二轮 P2-1）：申请可能在操作人范围外、字段也未必可见；
 * HTTP 入口用 disclosePendingApplications 按当前范围与字段权限换成可披露的明细。
 */
export class PendingApplicationError extends AppError {
  constructor(readonly pending: readonly PendingApplication[]) {
    super('CONFLICT', PENDING_MESSAGE, {
      reason: 'EMPLOYMENT_PENDING_APPLICATION_EXISTS',
      applications: [],
      hiddenCount: pending.length,
    });
  }
}

/** DEC-126：生效日不早于被删记录的申请，只要审批中或已批未生效就拦；草稿、驳回待重提的提交时会重新取原值。 */
export async function assertNoPendingApplication(
  tx: Tx,
  ctx: EmploymentContext,
  target: { readonly id: string; readonly employeeId: string; readonly effectiveDate: string },
): Promise<void> {
  const pending = rowsOf<PendingApplication>(
    await tx.execute(sql`
      SELECT b.id, b.employee_id AS "employeeId", p.department_id AS "departmentId", p.kind,
        p.effective_date::text AS "effectiveDate", s.state AS status
      FROM employment_business_objects b
      JOIN LATERAL (SELECT mode, kind, effective_date, department_id FROM employment_payload_versions
        WHERE tenant_id=b.tenant_id AND employee_id=b.employee_id AND business_id=b.id
        ORDER BY version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events
        WHERE tenant_id=b.tenant_id AND employee_id=b.employee_id AND business_id=b.id
        ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${target.employeeId}::uuid AND b.id<>${target.id}::uuid
        AND p.mode='application' AND p.effective_date>=${target.effectiveDate}::date
        AND s.state IN ('in_review','approved')
      ORDER BY p.effective_date, b.id LIMIT ${MAX_LISTED}
    `),
  );
  if (pending.length) throw new PendingApplicationError(pending);
}

/**
 * 拒绝详情的披露（P2-1）：只列操作人看得到的申请（DEC-177 统一可见判定，与详情接口同一口径），
 * 单号 / 类型 / 生效日按字段查看权裁剪（viewable 为空表示不限字段），状态是协议元数据；其余只计数。
 */
export async function disclosePendingApplications(
  tx: Tx,
  ctx: EmploymentContext,
  error: PendingApplicationError,
  viewable: ReadonlySet<string> | undefined,
): Promise<AppError> {
  const shown = (field: string) => viewable === undefined || viewable.has(field);
  const applications: Record<string, string>[] = [];
  for (const item of error.pending) {
    if (!(await employmentRecordVisibleTo(tx, ctx, item.employeeId, item.departmentId, item.id))) continue;
    applications.push({
      ...(shown('id') ? { id: item.id } : {}),
      ...(shown('kind') ? { kind: item.kind } : {}),
      ...(shown('effectiveDate') ? { effectiveDate: item.effectiveDate } : {}),
      status: item.status,
    });
  }
  return new AppError('CONFLICT', PENDING_MESSAGE, {
    reason: 'EMPLOYMENT_PENDING_APPLICATION_EXISTS',
    applications,
    hiddenCount: error.pending.length - applications.length,
  });
}

/**
 * 删除中间记录后，前一条的有效区间从 [前一条生效日, 被删记录生效日) 接到 [.., 后一条生效日)（`07` A11）。
 * 恢复出来的那一段等于前一条在新日期上重新生效，须过与新增 / 编辑相同的约束（PR #73 第二轮）：
 * - P1-1：前一条是本次联动改写的对象，按 DEC-178（F-015 统一可见判定）不可见即整单拒绝，保留 DEC-084 拒绝码；
 *   被删记录本身是直接操作，仍按写入口径（DEC-193）；
 *   并写一条审计，让命令足迹复核把它纳入事务内授权；
 * - P2-2 循环汇报、P2-3 部门在恢复区间内停用、P2-4 严格编制（按实际恢复区间，不按整个周期）。
 * 离职 / 退休记录（删除再入职时恢复的上一周期末条）不占编、不汇报，只做范围检查。
 */
export async function assertRestoredPredecessor(
  tx: Tx,
  ctx: EmploymentContext,
  deleted: EmploymentRecord,
  restored: { readonly previousId: string; readonly window: ReportingWindow },
): Promise<void> {
  const { window } = restored;
  const previous = await loadEmploymentRecord(tx, ctx.tenantId, restored.previousId, window.from);
  if (!previous) throw new AppError('SERVICE_UNAVAILABLE', '前一条任职记录不可读');
  await requireLinkedEmploymentRecord(tx, ctx, previous.employeeId, previous.fields.departmentId, previous.id);
  await auditEmployment(
    tx,
    ctx,
    'employment.record.restore',
    'employment-record',
    previous.id,
    { validUntil: window.from },
    { validUntil: window.to },
  );
  if (window.to === window.from || ['leave', 'retirement'].includes(previous.kind)) return;
  const { fields } = previous;
  if (fields.departmentId) {
    const disabled = await employmentDepartmentDisable(tx, ctx.tenantId, fields.departmentId, window.from);
    if (disabled && (window.to === null || disabled.disabledOn < window.to))
      throw new AppError(
        'VALIDATION_FAILED',
        `任职部门【${disabled.name}】已被停用（停用日期：${disabled.disabledOn}），请检查`,
        { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED', disabledOn: disabled.disabledOn },
      );
  }
  await validateEmploymentReferences(tx, ctx, fields, window.from, { employeeId: previous.employeeId, window });
  const moved = fields.departmentId !== deleted.fields.departmentId || fields.positionId !== deleted.fields.positionId;
  // 编制单一判定入口只按“调入”口径计算（DEC-145）；恢复区间等于前一条在恢复日重新调入其部门。
  if (fields.departmentId && moved)
    await assertEstablishmentCapacity(tx, ctx, {
      businessId: previous.id,
      employeeId: previous.employeeId,
      kind: 'transfer',
      departmentId: fields.departmentId,
      positionId: fields.positionId,
      effectiveDate: window.from,
      until: window.to,
      fields,
    });
}

export async function assertNoLinkedChanges(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord): Promise<void> {
  const changes: LinkedChange[] = [];
  for (const probe of probes.values()) changes.push(...(await probe(tx, ctx, record)));
  if (!changes.length) return;
  const labels = changes.map((change) => change.label);
  const listed = labels.length > 1 ? `${labels.slice(0, -1).join('、')}及${labels.at(-1)}` : labels[0];
  // 中文与数字之间留一个空格，与 DEC-172 的提示示例“及 N 名员工的直线经理”一致。
  const message = `已联动修改${listed}，请先调整后再删除`.replace(/([一-鿿】])(\d)/gu, '$1 $2');
  throw new AppError('CONFLICT', message, { reason: 'EMPLOYMENT_LINKED_CHANGES_EXIST', linkages: changes });
}

interface OrganizationLinked {
  readonly departmentId: string | null;
  readonly isDepartmentHead: boolean | null;
  readonly isStoreManager: boolean | null;
  readonly addedSubordinateIds: readonly string[] | null;
}

/**
 * DEC-172：调动生效时联动设过部门负责人 / 店长、改过新增下属的直线经理（transfer-linkage.ts）。
 * 以联动完成事件为准；只看今天及以后仍生效的组织版本与下属任职，已被 HR 调整掉的不再算。
 */
async function organizationLinkage(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord) {
  if (record.kind !== 'transfer') return [];
  const [event] = rowsOf<{ linked: OrganizationLinked }>(
    await tx.execute(sql`
      SELECT payload->'after' AS linked FROM employment_outbox
      WHERE tenant_id=${ctx.tenantId} AND business_id=${record.id}::uuid AND event_type='employment.transfer.linked'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `),
  );
  if (!event) return [];
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const { linked } = event;
  const changes: LinkedChange[] = [];
  if (linked.departmentId && (linked.isDepartmentHead || linked.isStoreManager)) {
    const roles = await remainingOrgRoles(tx, ctx, linked, record.employeeId, today);
    if (roles.roles.length)
      changes.push({
        kind: 'organization',
        label: `【${roles.name}】${roles.roles.map((role) => ROLE_LABELS[role]).join('、')}`,
        orgId: linked.departmentId,
        roles: roles.roles,
      });
  }
  const count = await remainingSubordinates(tx, ctx, linked.addedSubordinateIds ?? [], record.employeeId, today);
  if (count) changes.push({ kind: 'directManager', label: `${count} 名员工的直线经理`, count });
  return changes;
}

const ROLE_LABELS = { personInCharge: '负责人', shopOwner: '店长' } as const;

/** 组织版本按“生效日 + 版本号”取当日有效版本（同 org/read-model.ts）；今天及以后任一版本仍是本人即算仍在。 */
async function remainingOrgRoles(
  tx: Tx,
  ctx: EmploymentContext,
  linked: OrganizationLinked,
  employeeId: string,
  today: string,
) {
  const [row] = rowsOf<{ head: boolean | null; shop: boolean | null; name: string | null }>(
    await tx.execute(sql`
      WITH effective AS (
        SELECT DISTINCT ON (start_date) start_date, stop_date, name, person_in_charge_id, shop_owner_id
        FROM org_versions WHERE tenant_id=${ctx.tenantId} AND org_id=${linked.departmentId}::uuid
        ORDER BY start_date, version_no DESC
      ), remaining AS (
        SELECT * FROM effective WHERE stop_date>=${today}::date
          AND start_date>=COALESCE((SELECT max(start_date) FROM effective WHERE start_date<=${today}::date),
            '-infinity'::date)
      )
      SELECT bool_or(person_in_charge_id=${employeeId}::uuid) AS head,
        bool_or(shop_owner_id=${employeeId}::uuid) AS shop,
        (SELECT name FROM remaining ORDER BY start_date LIMIT 1) AS name
      FROM remaining
    `),
  );
  const roles: (keyof typeof ROLE_LABELS)[] = [];
  if (linked.isDepartmentHead && row?.head) roles.push('personInCharge');
  if (linked.isStoreManager && row?.shop) roles.push('shopOwner');
  return { roles, name: row?.name ?? '' };
}

/** 新增下属今天及以后的任职里直线经理仍是本人的人数（任职快照优先于原始记录，同 read-model.ts）。 */
async function remainingSubordinates(
  tx: Tx,
  ctx: EmploymentContext,
  subordinateIds: readonly string[],
  employeeId: string,
  today: string,
): Promise<number> {
  if (!subordinateIds.length) return 0;
  const [row] = rowsOf<{ count: number }>(
    await tx.execute(sql`
      SELECT count(DISTINCT t.employee_id)::int AS count FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      LEFT JOIN LATERAL (
        SELECT p.direct_manager_id, true AS present FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1
      ) snapshot ON true
      WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=ANY(${`{${subordinateIds.join(',')}}`}::uuid[])
        AND NOT isempty(t.valid_during) AND (upper_inf(t.valid_during) OR upper(t.valid_during)>${today}::date)
        AND (CASE WHEN snapshot.present THEN snapshot.direct_manager_id ELSE r.direct_manager_id END)
          =${employeeId}::uuid
    `),
  );
  return Number(row?.count ?? 0);
}
