/** F-321：旧文本按名称精确映射；未知置空，三种载荷表均迁移且保持稳定 ID。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';

const database = useTestDb({ migrateBefore: '_employment_forms' });
const rows = <T>(v: unknown) => (Array.isArray(v) ? v : (v as { rows: T[] }).rows) as T[];

it('AC-EMP-F321-09：两个租户的主职 / 兼职载荷及申请迁移，未知和非精确名称置空', async () => {
  const db = database().db;
  const targets: { tenantId: string; id: string; value: string | null }[] = [];
  for (const label of ['migration-a', 'migration-b']) {
    const s = await employmentSession(db, label);
    const org = await s.org('合成迁移部门', { establishedOn: '2020-01-01' });
    const e = await s.employee();
    await withTenant(db, s.tenant.id, async (tx) => {
      for (const name of ['正式员工', '兼职人员', '劳务派遣', '不存在', ' 正式员工', null]) {
        const id = randomUUID();
        const payload = randomUUID();
        const primary = name === '正式员工';
        const kind = primary ? 'hire' : 'part_time';
        const service = primary ? 'primary' : 'part_time';
        const cycle = randomUUID();
        const date = `202${targets.filter((i) => i.tenantId === s.tenant.id).length}-01-01`;
        await tx.execute(sql`INSERT INTO employment_cycles(id,tenant_id,employee_id,entry_date,entry_type,employ_type)
          VALUES (${cycle},${s.tenant.id},${e.id},${date},'hire','internal')`);
        await tx.execute(sql`INSERT INTO employment_business_objects(id,tenant_id,employee_id)
          VALUES (${id},${s.tenant.id},${e.id})`);
        await tx.execute(sql`INSERT INTO employment_payload_versions
          (id,tenant_id,employee_id,business_id,version_no,kind,mode,effective_date,form_id,
           employment_form,employee_status)
          VALUES (${payload},${s.tenant.id},${e.id},${id},1,${kind},'direct',${date},'part_time',${name},3)`);
        await tx.execute(sql`INSERT INTO employment_records
          (id,tenant_id,employee_id,payload_version_id,staff_id,entry_date,kind,start_date,service_type,
           employment_form,employee_status,employ_type)
          VALUES (${id},${s.tenant.id},${e.id},${payload},${cycle},${date},${kind},${date},
            ${service},${name},3,'internal')`);
        if (primary)
          await tx.execute(sql`INSERT INTO employment_timeline
          (tenant_id,employee_id,record_id,staff_id,start_date,sort_order,valid_during)
          VALUES (${s.tenant.id},${e.id},${id},${cycle},${date},1,daterange(${date}::date,NULL,'[)'))`);
        await tx.execute(sql`INSERT INTO part_time_requests
          (id,tenant_id,employee_id,request_type,initiator,initiator_user_id)
          VALUES (${id},${s.tenant.id},${e.id},'add','hr',${s.user.id})`);
        await tx.execute(sql`INSERT INTO part_time_request_versions
          (id,tenant_id,employee_id,request_id,version_no,command_id,service_type,department_id,
           start_date,employment_form)
          VALUES (${payload},${s.tenant.id},${e.id},${id},1,${randomUUID()},'part_time',${org.id},${date},${name})`);
        targets.push({ tenantId: s.tenant.id, id, value: name });
      }
    });
  }
  await database().migrate();
  for (const target of targets) {
    await withTenant(db, target.tenantId, async (tx) => {
      const [form] = rows<{ code: string }>(
        await tx.execute(sql`
        SELECT code FROM employment_forms WHERE tenant_id=${target.tenantId} AND name=${target.value}`),
      );
      if (['正式员工', '兼职人员', '劳务派遣'].includes(target.value ?? '')) expect(form?.code).toBeTruthy();
      for (const [table, key] of [
        ['employment_records', 'id'],
        ['employment_payload_versions', 'business_id'],
        ['part_time_request_versions', 'request_id'],
      ]) {
        const [record] = rows<{ employment_form: string | null }>(
          await tx.execute(sql`
          SELECT employment_form FROM ${sql.identifier(table!)}
          WHERE tenant_id=${target.tenantId} AND ${sql.identifier(key!)}=${target.id}`),
        );
        expect(record?.employment_form).toBe(form?.code ?? null);
      }
    });
  }
  // 新增迁移必须恢复只追加触发器，不给运行时留下改写历史的通道。
  const triggers = rows<{ tgenabled: string }>(
    await db.execute(sql`
    SELECT tgenabled FROM pg_trigger WHERE tgname IN (
      'employment_records_append_only', 'employment_payload_versions_append_only',
      'part_time_request_versions_append_only')`),
  );
  expect(triggers).toHaveLength(3);
  expect(triggers.every((t) => t.tgenabled === 'O')).toBe(true);
});
