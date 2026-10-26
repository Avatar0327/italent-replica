/** DEC-691：合成数据；组织 / 职务历史通过追加版本构造，租户写入均用 withTenant。 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant, type Db } from '@italent/db';
import type { ApproverSource } from '@italent/domain';
import { resolveSource } from '../../apps/api/src/modules/approval/source-resolver.js';
import { approvalWorld, type ApprovalWorld } from './AC-APV-support.js';

export const source = (type: ApproverSource['type'], id: string, suffix = ''): ApproverSource => ({
  type,
  value: id + suffix,
});
export async function relationWorld(db: Db, label: string) {
  const w = await approvalWorld(db, label);
  const root = await w.org('合成中心');
  const child = await w.org('合成子部门', root);
  const staff = await w.org('合成人员部门');
  const head = await w.person('合成甲', staff);
  const near = await w.person('合成乙', child);
  const subject = await w.person('合成申请对象', child);
  await w.setOrgRoles(root, { head: head.employeeId });
  await w.setOrgRoles(child, { head: near.employeeId });
  return { ...w, root, child, staff, head, near, subject };
}
export type RelationWorld = Awaited<ReturnType<typeof relationWorld>>;

export async function orgVersion(
  w: { db: Db; tenant: { id: string } },
  id: string,
  patch: Partial<typeof orgVersions.$inferInsert> = {},
  parents?: Record<string, string | null>,
) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const [old] = await tx
      .select()
      .from(orgVersions)
      .where(eq(orgVersions.orgId, id))
      .orderBy(sql`version_no DESC`)
      .limit(1);
    const versionId = randomUUID();
    await tx
      .insert(orgVersions)
      .values({ ...old!, ...patch, id: versionId, versionNo: old!.versionNo + 1, previousVersionId: old!.id });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    const all = new Map(links.map((l) => [l.dimension as string, l.parentOrgId]));
    for (const [key, value] of Object.entries(parents ?? {})) all.set(key, value);
    await tx.insert(orgHierarchyLinks).values(
      [...all].map(([dimension, parentOrgId]) => ({
        tenantId: w.tenant.id,
        versionId,
        dimension: dimension as 'admin',
        parentOrgId,
      })),
    );
  });
}
export async function dimensions(w: ApprovalWorld, enabled = true) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE org_settings SET
    business_enabled=${enabled},product_enabled=${enabled},reserve4_enabled=${enabled},reserve5_enabled=${enabled}
    WHERE tenant_id=${w.tenant.id}`),
  );
}
export async function job(w: ApprovalWorld, kind: 'posts' | 'positions', extra: Record<string, unknown> = {}) {
  return w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/job/${kind}`, {
      ifMatch: 0,
      body: { name: '合成岗位', code: `J_${randomUUID()}`, startDate: '2020-01-01', ...extra },
    }),
    201,
  );
}
export async function stopJob(w: ApprovalWorld, kind: 'post' | 'position', id: string, start = '2026-09-01') {
  await withTenant(w.db, w.tenant.id, (tx) => {
    const table = sql.identifier(`job_${kind}_versions`);
    return tx.execute(sql`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(v) ||
      jsonb_build_object('id',${randomUUID()}::text,'previous_version_id',v.id,'version_no',v.version_no+1,
        'start_date',${start}::text,'enabled',false))).*
      FROM ${table} v WHERE tenant_id=${w.tenant.id} AND object_id=${id}::uuid
      ORDER BY version_no DESC LIMIT 1`);
  });
}
export async function change(w: ApprovalWorld, employeeId: string, fields: Record<string, unknown>, date: string) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
  );
  return w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'org_adjustment', mode: 'direct', effectiveDate: date, fields },
    }),
    201,
  );
}
export function resolved(w: RelationWorld, value: ApproverSource, businessDate = '2026-10-01') {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    (
      await resolveSource(
        tx,
        {
          tenantId: w.tenant.id,
          asOf: '2026-10-01',
          businessDate,
          initiatorUserId: w.hr.id,
          subjectEmployeeId: w.subject.employeeId,
          latestDepartmentId: w.child,
          recordDepartmentId: w.child,
        },
        value,
      )
    )
      .flatMap((c) => c.userId ?? [])
      .sort(),
  );
}
export function save(w: ApprovalWorld, values: ApproverSource[], approvalType = 'transfer') {
  return w.request(w.hr.id, 'POST', '/api/tenant/approval/processes', {
    ifMatch: 0,
    body: {
      code: `P_${randomUUID().replaceAll('-', '')}`,
      name: '合成来源流程',
      approvalType,
      isFallback: true,
      exceptionAdminUserId: w.exceptionAdmin,
      conditions: { items: [] },
      nodes: [{ key: 'source', kind: 'countersign', approvers: values, transitionRule: { type: 'all' } }],
    },
  });
}
