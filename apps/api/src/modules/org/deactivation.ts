/**
 * DEC-129（`10` §9）：组织自某日起不可用（停用，或失效日期提前）时，整支下级（行政维度各级）同日级联停用；
 * 整支（含本组织）自该日起仍有在职人员或启用中的职位时拒绝，列出所在组织与人数 / 职位数。
 * DEC-196：审批中、审批通过未生效的调入申请同样计入；只读最新载荷与状态，不重复计已落地申请。
 * 原站停用时可把整支人员、职位转入替换组织（强推断）；复刻有意不做自动转移，与 DEC-016 一致。
 */
import { and, asc, eq, orgVersions, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { countDepartmentStaff } from '../employment/org-people.js';
import { rowsOf } from '../employment/read-model.js';
import { countEnabledPositions } from '../job/read-model.js';
import { futureBoundaries, loadOrgSnapshot, type OrgRecord } from './read-model.js';
import type { NormalizedOrganization, OrgWriteContext } from './validation.js';

/** 级联涉及的组织须都在操作人数据范围内，由路由按当前范围逐个校验（范围外一律按不存在处理，不列名称）。 */
export type CascadeAuthorizer = (tx: Tx, orgIds: readonly string[]) => Promise<void>;

/** 单次级联停用的下级上限（AGENTS §10 批量上限）；错误中列出的组织数上限。 */
const CASCADE_LIMIT = 1000;
const REPORT_LIMIT = 100;

export interface SubtreeOccupancy {
  readonly orgId: string;
  readonly code: string;
  readonly name: string;
  readonly employeeCount: number;
  readonly positionCount: number;
}

/** 新版本让组织从哪天起不可用：本次由启用变停用时取生效日；仍启用但失效日期提前时取新失效日的次日。 */
export function unavailableFrom(current: OrgRecord, next: NormalizedOrganization): string | null {
  if (current.enabled && !next.enabled) return next.startDate;
  if (next.enabled && next.stopDate < current.stopDate) return dayAfter(next.stopDate);
  return null;
}

/**
 * 校验并返回需要级联停用的下级（from 当天仍启用的）。整支取 from 及以后每个版本边界上的各级下级之并集：
 * 有未来版本的下级会让级联版本被覆盖（或之后才挂到本组织下），一律拒绝，提示先处理未来版本（`10` §15 同口径）。
 */
export async function planDeactivation(
  tx: Tx,
  ctx: OrgWriteContext,
  root: OrgRecord,
  from: string,
  authorize: CascadeAuthorizer | undefined,
): Promise<OrgRecord[]> {
  // 可信内部调用也统一标识；HTTP 入口已在权限判断前规范化。
  root = { ...root, id: root.id.toLowerCase() };
  const descendants = new Set<string>();
  let atFrom: OrgRecord[] = [];
  for (const boundary of await futureBoundaries(tx, ctx.tenantId, from)) {
    const snapshot = await loadOrgSnapshot(tx, ctx.tenantId, boundary);
    if (boundary === from) atFrom = snapshot;
    for (const id of subtree(snapshot, root.id)) descendants.add(id);
    if (descendants.size > CASCADE_LIMIT) {
      throw new AppError('PAYLOAD_TOO_LARGE', `单次停用最多级联 ${CASCADE_LIMIT} 个下级组织`);
    }
  }
  const ids = [...descendants];
  if (ids.length) {
    if (!authorize) throw new AppError('FORBIDDEN', '级联停用必须校验下级组织的数据范围');
    await authorize(tx, ids);
  }
  await rejectFutureDescendantVersions(tx, ctx, ids, from);
  await assertSubtreeVacant(tx, ctx, root, ids, from, atFrom);
  return atFrom.filter((node) => descendants.has(node.id) && node.enabled);
}

/** 按行政维度向下遍历；本组织在该时点已失效时，仍按下级记录的上级 ID 找到它们。 */
function subtree(snapshot: readonly OrgRecord[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const node of snapshot) {
    const parentId = node.parents.admin?.parentId;
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), node.id]);
  }
  const found: string[] = [];
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === rootId || found.includes(id)) continue;
    found.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return found;
}

async function rejectFutureDescendantVersions(tx: Tx, ctx: OrgWriteContext, ids: readonly string[], from: string) {
  if (!ids.length) return;
  const [future] = await tx
    .select({ orgId: orgVersions.orgId, code: orgVersions.code, startDate: orgVersions.startDate })
    .from(orgVersions)
    .where(
      and(
        eq(orgVersions.tenantId, ctx.tenantId),
        sql`${orgVersions.orgId} = ANY(${`{${ids.join(',')}}`}::uuid[])`,
        sql`${orgVersions.startDate} > ${from}::date`,
      ),
    )
    .orderBy(asc(orgVersions.startDate), asc(orgVersions.code))
    .limit(1);
  if (future) {
    throw new AppError('ORG_FUTURE_VERSION_EXISTS', '下级组织存在未来生效的组织变动，请先处理该变动后再停用', {
      reason: 'DESCENDANT_FUTURE_VERSION',
      orgId: future.orgId,
      code: future.code,
      effectiveDate: future.startDate,
    });
  }
}

async function assertSubtreeVacant(
  tx: Tx,
  ctx: OrgWriteContext,
  root: OrgRecord,
  descendants: readonly string[],
  from: string,
  atFrom: readonly OrgRecord[],
) {
  const ids = [root.id, ...descendants];
  // updateOrganization 已由 ensureOrgSetup 持有租户 org_settings 排他锁。
  // 调入提交 / 审批 / 落地的 assertEmploymentDepartmentAvailable 持同一锁，两个统计间不能迁移状态。
  const staff = await countDepartmentStaff(tx, ctx.tenantId, ids, from);
  const pending = await countPendingTransfers(tx, ctx.tenantId, ids);
  const positions = await countEnabledPositions(tx, ctx.tenantId, ids, from);
  const byId = new Map(atFrom.map((node) => [node.id, node]));
  const occupied: SubtreeOccupancy[] = ids
    .map((id) => {
      const node = id === root.id ? root : byId.get(id);
      return {
        orgId: id,
        code: node?.code ?? '',
        name: node?.name ?? '',
        employeeCount: (staff.get(id) ?? 0) + (pending.get(id) ?? 0),
        positionCount: positions.get(id) ?? 0,
      };
    })
    .filter((row) => row.employeeCount > 0 || row.positionCount > 0)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  if (!occupied.length) return;
  const count = occupied.reduce((sum, row) => sum + row.employeeCount, 0);
  const message = count
    ? `当前组织或下级组织中存在待入职或在职员工任职记录${count}条，不能被停用`
    : '组织及其下级组织仍有在职人员或启用中的职位，请先调出人员、处理职位后再停用';
  throw new AppError('CONFLICT', message, {
    reason: 'ORG_SUBTREE_NOT_EMPTY',
    effectiveDate: from,
    organizations: occupied.slice(0, REPORT_LIMIT),
    ...(occupied.length > REPORT_LIMIT ? { truncated: true, organizationCount: occupied.length } : {}),
  });
}

/** DEC-196：在途按申请单计数，不按员工去重；计划日在停用日前也可能继续占用，不能按日期过滤。 */
async function countPendingTransfers(
  tx: Tx,
  tenantId: string,
  orgIds: readonly string[],
): Promise<Map<string, number>> {
  const rows = rowsOf<{ orgId: string; count: number }>(
    await tx.execute(sql`
      SELECT p.department_id AS "orgId", count(*)::int AS count
      FROM employment_business_objects b
      JOIN LATERAL (SELECT mode, kind, department_id FROM employment_payload_versions
        WHERE tenant_id=b.tenant_id AND employee_id=b.employee_id AND business_id=b.id
        ORDER BY version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events
        WHERE tenant_id=b.tenant_id AND employee_id=b.employee_id AND business_id=b.id
        ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${tenantId} AND p.mode='application' AND p.kind='transfer'
        AND s.state IN ('in_review','approved')
        AND p.department_id = ANY(${`{${orgIds.join(',')}}`}::uuid[])
      GROUP BY p.department_id
    `),
  );
  return new Map(rows.map((row) => [row.orgId, Number(row.count)]));
}

/**
 * DEC-129 的另一面：启用的组织不能挂在停用（或之后排定停用、失效）的行政上级下——新建、改上级、重新启用
 * 都按本版本有效期内上级的每个版本判断。级联停用之后，下级须在上级重新启用后再逐个启用。
 */
export async function assertParentAvailable(
  tx: Tx,
  ctx: OrgWriteContext,
  input: {
    readonly parents: { readonly admin?: { readonly parentId: string | null } };
    readonly enabled: boolean;
    readonly startDate: string;
    readonly stopDate: string;
  },
) {
  const parentId = input.parents.admin?.parentId;
  if (!input.enabled || !parentId || parentId === ctx.tenantId) return;
  const versions = await tx
    .select({ startDate: orgVersions.startDate, stopDate: orgVersions.stopDate, enabled: orgVersions.enabled })
    .from(orgVersions)
    .where(and(eq(orgVersions.tenantId, ctx.tenantId), eq(orgVersions.orgId, parentId)))
    .orderBy(asc(orgVersions.startDate), asc(orgVersions.versionNo));
  const points = new Set([input.startDate]);
  for (const version of versions) {
    if (version.startDate > input.startDate) points.add(version.startDate);
    if (version.stopDate < '9999-12-31') points.add(dayAfter(version.stopDate));
  }
  for (const point of [...points].filter((day) => day >= input.startDate && day <= input.stopDate).sort()) {
    const effective = versions.filter((version) => version.startDate <= point).at(-1);
    if (effective?.enabled && effective.stopDate >= point) continue;
    throw new AppError('VALIDATION_FAILED', `上级组织自 ${point} 起停用或失效，不能在其下启用组织`, {
      reason: 'PARENT_UNAVAILABLE',
      fields: { 'parents.admin.parentId': '上级组织已停用或将停用' },
      unavailableFrom: point,
    });
  }
}

function dayAfter(value: string): string {
  const day = new Date(`${value}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}
