import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';
const database = useTestDb();

it.each([false, true])('AC-ORG-30 1001 人联动超限，整单不写入（导入=%s）', async (viaImport) => {
  const db = database().db;
  const w = await orgPeopleWorld(db, 'org30');
  const root = await w.org('批量部门');
  const seed = await w.hire('合成种子', { departmentId: root.id });
  const key = randomUUID();
  // 批量复制真实入职的强类型行，保留约束；全部是独立的合成人员/周期/业务，无真实个人数据。
  const people = Array.from({ length: 1000 }, () => ({
    employee: randomUUID(),
    business: randomUUID(),
    payload: randomUUID(),
    staff: randomUUID(),
    code: randomUUID(),
  }));
  await withTenant(db, w.tenant.id, async (tx) => {
    const [origin] = resultRows<{ staff: string; payload: string }>(
      await tx.execute(sql`
      SELECT staff_id AS staff,payload_version_id AS payload FROM employment_records WHERE id=${seed.recordId}::uuid
    `),
    );
    const rows = sql`jsonb_to_recordset(${JSON.stringify(people)}::jsonb)
      AS c(employee uuid,business uuid,payload uuid,staff uuid,code text)`;
    const copies = [
      ['employment_employees', seed.id, sql`jsonb_build_object('id',c.employee,'code',c.code)`],
      ['employment_business_objects', seed.recordId, sql`jsonb_build_object('id',c.business,'employee_id',c.employee)`],
      ['employment_cycles', origin!.staff, sql`jsonb_build_object('id',c.staff,'employee_id',c.employee)`],
      [
        'employment_payload_versions',
        origin!.payload,
        sql`jsonb_build_object('id',c.payload,'business_id',c.business,'employee_id',c.employee,'job_number',c.code)`,
      ],
      [
        'employment_records',
        seed.recordId,
        sql`jsonb_build_object('id',c.business,'employee_id',c.employee,'payload_version_id',c.payload,
          'staff_id',c.staff,'job_number',c.code)`,
      ],
    ] as const;
    for (const [table, id, replacements] of copies) {
      await tx.execute(sql`INSERT INTO ${sql.identifier(table)}
        SELECT (jsonb_populate_record(NULL::${sql.identifier(table)},to_jsonb(s)||${replacements})).*
        FROM ${sql.identifier(table)} s CROSS JOIN ${rows}
        WHERE s.tenant_id=${w.tenant.id} AND s.id=${id}::uuid`);
    }
    await tx.execute(sql`INSERT INTO employment_timeline
      SELECT (jsonb_populate_record(NULL::employment_timeline,to_jsonb(s)||jsonb_build_object(
        'employee_id',c.employee,'record_id',c.business,'staff_id',c.staff))).*
      FROM employment_timeline s CROSS JOIN ${rows}
      WHERE s.tenant_id=${w.tenant.id} AND s.record_id=${seed.recordId}::uuid`);
  });
  const response = await w.call(
    viaImport ? 'POST' : 'PATCH',
    viaImport ? 'org/import' : `org/organizations/${root.id}`,
    {
      ifMatch: viaImport ? 0 : root.revision,
      idempotencyKey: key,
      body: viaImport
        ? {
            rows: [
              {
                sourceCode: root.id,
                orgId: root.id,
                code: root.code,
                name: '不应保存',
                parentId: w.tenant.id,
                expectedRevision: root.revision,
                startDate: '2026-10-08',
                addEmployment: true,
              },
            ],
          }
        : { name: '不应保存', effectiveDate: '2026-10-08', addEmployment: true },
    },
  );
  expect(response.status, await response.clone().text()).toBe(413);
  expect((await w.orgsAt('2026-10-08')).get(root.id)).toMatchObject({ revision: 1, name: '批量部门' });
  await withTenant(db, w.tenant.id, async (tx) => {
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM employment_records
      WHERE tenant_id=${w.tenant.id} AND kind='org_adjustment'`),
      ),
    ).toEqual([]);
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM audit_events
      WHERE tenant_id=${w.tenant.id} AND command_id=${key}`),
      ),
    ).toEqual([]);
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM employment_outbox
      WHERE tenant_id=${w.tenant.id} AND command_id=${key}`),
      ),
    ).toEqual([]);
  });
});
