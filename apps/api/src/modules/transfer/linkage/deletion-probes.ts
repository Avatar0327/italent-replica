/**
 * DEC-012：调动联动改写过的合同、下属经理、组织角色仍保持联动结果时，拒绝删除该调动（R1-T11 删除守卫的探针，
 * 第四轮 P2）。只看“当前仍在”的结果，HR 之后手工调整过的不再拦截（同 deletion-guards.ts 的组织探针）。
 * 提示只给件数，不带合同编号、姓名、组织名：删除操作人未必看得到这些对象或字段。
 * 兼职结束按 DEC-191 只有端口，生产端口不会产生成功子项，暂不登记。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { registerDeletionLinkageProbe, type LinkedChange } from '../../employment/deletion-guards.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext, EmploymentRecord } from '../../employment/types.js';
import type { DutyRelation, OrgRole } from './input.js';

/** 生产装配时登记（registerTransferLinkageRoutes）；同名重复登记即替换。 */
export function registerTransferDeletionProbes(): void {
  registerDeletionLinkageProbe('transfer-linkage:contract', contractProbe);
  registerDeletionLinkageProbe('transfer-linkage:subordinate', subordinateProbe);
  registerDeletionLinkageProbe('transfer-linkage:org-role', orgRoleProbe);
}

/** 联动生成的新合同仍有效、且没有被之后的合同版本取代（HR 再次变更、续签、终止都算已调整）。 */
async function contractProbe(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord): Promise<LinkedChange[]> {
  if (record.kind !== 'transfer') return [];
  const [row] = rowsOf<{ count: number }>(
    await tx.execute(sql`
      SELECT count(*)::int AS count FROM transfer_linkage_runs r
      JOIN contract_records c ON c.tenant_id=r.tenant_id AND c.id=r.after_contract_id
      WHERE r.tenant_id=${ctx.tenantId} AND r.business_id=${record.id}::uuid
        AND NOT c.deleted AND c.status='valid'
        AND NOT EXISTS (SELECT 1 FROM contract_records n WHERE n.tenant_id=c.tenant_id
          AND n.previous_contract_id=c.id AND NOT n.deleted AND n.status<>'void')
    `),
  );
  const count = Number(row?.count ?? 0);
  return count ? [{ kind: 'contract', label: `${count} 份合同`, count }] : [];
}

const RELATION_LABELS = { direct: '直线经理', dotted: '虚线经理' } as const satisfies Record<DutyRelation, string>;

/** 转交成功的下属，今天及以后的任职里直线 / 虚线经理仍是接收人（任职快照优先于原始记录，同 read-model.ts）。 */
async function subordinateProbe(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord): Promise<LinkedChange[]> {
  if (record.kind !== 'transfer') return [];
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const rows = rowsOf<{ relation: DutyRelation; count: number }>(
    await tx.execute(sql`
      SELECT i.relation, count(DISTINCT i.subordinate_id)::int AS count FROM transfer_linkage_items i
      WHERE i.tenant_id=${ctx.tenantId} AND i.business_id=${record.id}::uuid
        AND i.item_type='duty_subordinate' AND i.status='succeeded'
        AND EXISTS (
          SELECT 1 FROM employment_timeline t
          JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
          LEFT JOIN LATERAL (
            SELECT p.direct_manager_id, p.dotted_manager_id, true AS present FROM employment_payload_versions p
            WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id
              AND p.is_record_snapshot
            ORDER BY p.version_no DESC LIMIT 1
          ) snapshot ON true
          WHERE t.tenant_id=i.tenant_id AND t.employee_id=i.subordinate_id AND NOT isempty(t.valid_during)
            AND (upper_inf(t.valid_during) OR upper(t.valid_during)>${today}::date)
            AND CASE WHEN i.relation='direct'
              THEN (CASE WHEN snapshot.present THEN snapshot.direct_manager_id ELSE r.direct_manager_id END)
              ELSE (CASE WHEN snapshot.present THEN snapshot.dotted_manager_id ELSE r.dotted_manager_id END)
            END=i.receiver_id)
      GROUP BY i.relation ORDER BY i.relation
    `),
  );
  return rows.map((row) => ({
    kind: 'dutySubordinate',
    label: `${row.count} 名员工的${RELATION_LABELS[row.relation]}`,
    relation: row.relation,
    count: Number(row.count),
  }));
}

const ROLE_LABELS = { person_in_charge: '负责人', shop_owner: '店长', hrbp: 'HRBP' } as const satisfies Record<
  OrgRole,
  string
>;

/** 转交成功的组织角色，今天生效的组织版本及其后的版本里仍由接收人担任（取版本口径同 deletion-guards.ts）。 */
async function orgRoleProbe(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord): Promise<LinkedChange[]> {
  if (record.kind !== 'transfer') return [];
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const rows = rowsOf<{ role: OrgRole; count: number }>(
    await tx.execute(sql`
      SELECT i.org_role AS role, count(DISTINCT i.org_id)::int AS count FROM transfer_linkage_items i
      WHERE i.tenant_id=${ctx.tenantId} AND i.business_id=${record.id}::uuid
        AND i.item_type='duty_org_role' AND i.status='succeeded'
        AND EXISTS (
          SELECT 1 FROM (
            SELECT DISTINCT ON (v.start_date) v.start_date, v.stop_date,
              v.person_in_charge_id, v.shop_owner_id, v.hrbp_id
            FROM org_versions v WHERE v.tenant_id=i.tenant_id AND v.org_id=i.org_id
            ORDER BY v.start_date, v.version_no DESC
          ) e
          WHERE e.stop_date>=${today}::date
            AND e.start_date>=COALESCE((SELECT max(v.start_date) FROM org_versions v
              WHERE v.tenant_id=i.tenant_id AND v.org_id=i.org_id AND v.start_date<=${today}::date), '-infinity'::date)
            AND CASE i.org_role WHEN 'person_in_charge' THEN e.person_in_charge_id
              WHEN 'shop_owner' THEN e.shop_owner_id ELSE e.hrbp_id END=i.receiver_id)
      GROUP BY i.org_role ORDER BY i.org_role
    `),
  );
  return rows.map((row) => ({
    kind: 'dutyOrgRole',
    label: `${row.count} 个组织的${ROLE_LABELS[row.role]}`,
    role: row.role,
    count: Number(row.count),
  }));
}
