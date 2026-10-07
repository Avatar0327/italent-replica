/**
 * F-022 存量回填（迁移 *_employee_status）：在迁移前的结构上造历史任职版本，升级后核对两个状态字段，
 * 且回填不改动任何其他列。回填规则见迁移注释。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { withPreAuditSchema } from './support/pre-audit-schema.js';

const database = useTestDb({ migrateBefore: '_employee_status' });
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface Step {
  readonly kind: string;
  readonly date: string;
  readonly staff: string;
  readonly entry: string;
  readonly employType?: 'internal' | 'intern';
}

async function legacyChain(tx: Tx, tenantId: string, employeeId: string, steps: readonly Step[]) {
  const ids: string[] = [];
  let order = 0;
  for (const step of steps) {
    const [business, payload] = [randomUUID(), randomUUID()];
    const employType = step.employType ?? 'internal';
    ids.push(business);
    if (['hire', 'rehire', 'retire_rehire'].includes(step.kind))
      await tx.execute(sql`INSERT INTO employment_cycles (id,tenant_id,employee_id,entry_date,entry_type,employ_type)
        VALUES (${step.staff},${tenantId},${employeeId},${step.date},${step.kind},${employType})`);
    await tx.execute(sql`INSERT INTO employment_business_objects (id,tenant_id,employee_id)
      VALUES (${business},${tenantId},${employeeId})`);
    await tx.execute(sql`INSERT INTO employment_payload_versions
      (id,tenant_id,employee_id,business_id,version_no,kind,mode,effective_date,form_id,employ_type,remarks)
      VALUES (${payload},${tenantId},${employeeId},${business},1,${step.kind},'direct',${step.date},
        'standard',${employType},${`备注-${step.kind}-${step.date}`})`);
    await tx.execute(sql`INSERT INTO employment_state_events
      (tenant_id,employee_id,business_id,payload_version_id,event_no,state,command_id)
      VALUES (${tenantId},${employeeId},${business},${payload},1,'effective',${`legacy-${business}`})`);
    await tx.execute(sql`INSERT INTO employment_records
      (id,tenant_id,employee_id,payload_version_id,staff_id,entry_date,kind,start_date,employ_type,remarks)
      VALUES (${business},${tenantId},${employeeId},${payload},${step.staff},${step.entry},${step.kind},${step.date},
        ${employType},${`备注-${step.kind}-${step.date}`})`);
    order += 1;
    await tx.execute(sql`INSERT INTO employment_timeline
      (tenant_id,employee_id,record_id,staff_id,start_date,sort_order,valid_during)
      VALUES (${tenantId},${employeeId},${business},${step.staff},${step.date},${order},
        daterange(${step.date}::date,NULL,'[)'))`);
  }
  // 时间轴区间按下一条起始日截断（与业务写入一致）
  await tx.execute(sql`UPDATE employment_timeline t SET valid_during=daterange(t.start_date,n.next,'[)')
    FROM (SELECT record_id, lead(start_date) OVER (ORDER BY start_date,sort_order) AS next FROM employment_timeline
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid) n
    WHERE t.tenant_id=${tenantId} AND t.record_id=n.record_id`);
  return ids;
}

async function snapshot(tx: Tx, tenantId: string) {
  return rows<{ t: string; body: Record<string, unknown> }>(
    await tx.execute(sql`
      SELECT 'record' AS t, to_jsonb(r) - 'employee_status' - 'entry_status' AS body FROM employment_records r
      WHERE r.tenant_id=${tenantId}
      UNION ALL
      SELECT 'payload', to_jsonb(p) - 'employee_status' - 'entry_status' FROM employment_payload_versions p
      WHERE p.tenant_id=${tenantId}
      ORDER BY 1, 2`),
  );
}

it('AC-EMP-20 回填：有试用期且未转正为试用、转正及之后为正式、离职 / 退休、在途申请按前一条，其他列不变', async () => {
  const handle = database();
  const { session, people } = await withPreAuditSchema(handle.db, async () => {
    const session = await employmentSession(handle.db, 'empbackfill');
    const people = [];
    for (let i = 0; i < 5; i += 1) people.push(await session.employee());
    return { session, people };
  });
  const tenantId = session.tenant.id;
  const [a, b, c, d, e] = people.map((person) => person.id) as [string, string, string, string, string];
  const [aStaff, bStaff, bStaff2, cStaff] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [dStaff, eStaff] = [randomUUID(), randomUUID()];
  const ids = await withTenant(handle.db, tenantId, async (tx) => {
    const aIds = await legacyChain(tx, tenantId, a, [
      { kind: 'hire', date: '2025-01-01', staff: aStaff, entry: '2025-01-01' },
      { kind: 'transfer', date: '2025-03-01', staff: aStaff, entry: '2025-01-01' },
      { kind: 'regularization', date: '2025-06-01', staff: aStaff, entry: '2025-01-01' },
      { kind: 'transfer', date: '2025-09-01', staff: aStaff, entry: '2025-01-01' },
    ]);
    const bIds = await legacyChain(tx, tenantId, b, [
      { kind: 'hire', date: '2025-01-01', staff: bStaff, entry: '2025-01-01' },
      { kind: 'leave', date: '2025-12-01', staff: bStaff, entry: '2025-01-01' },
      { kind: 'rehire', date: '2026-01-01', staff: bStaff2, entry: '2026-01-01' },
    ]);
    const cIds = await legacyChain(tx, tenantId, c, [
      { kind: 'hire', date: '2025-01-01', staff: cStaff, entry: '2025-01-01' },
      { kind: 'retirement', date: '2026-02-01', staff: cStaff, entry: '2025-01-01' },
    ]);
    // DEC-234：D、E 先以实习生入职，再实习转正（按入职处理）
    const dIds = await legacyChain(tx, tenantId, d, [
      { kind: 'hire', date: '2025-01-01', staff: dStaff, entry: '2025-01-01', employType: 'intern' },
      { kind: 'transfer', date: '2025-02-01', staff: dStaff, entry: '2025-01-01', employType: 'intern' },
      { kind: 'intern_regularization', date: '2025-07-01', staff: dStaff, entry: '2025-01-01' },
      { kind: 'transfer', date: '2025-08-01', staff: dStaff, entry: '2025-01-01' },
    ]);
    const eIds = await legacyChain(tx, tenantId, e, [
      { kind: 'hire', date: '2025-01-01', staff: eStaff, entry: '2025-01-01', employType: 'intern' },
      { kind: 'intern_regularization', date: '2025-07-01', staff: eStaff, entry: '2025-01-01' },
    ]);
    // A 的 2025-03-01 调动被向后更新改写过：追加的记录快照
    await tx.execute(sql`INSERT INTO employment_payload_versions
      (id,tenant_id,employee_id,business_id,version_no,previous_version_id,command_id,trigger_business_id,
       is_record_snapshot,kind,mode,effective_date,form_id,employ_type,remarks)
      SELECT gen_random_uuid(),tenant_id,employee_id,business_id,2,id,'legacy-forward',business_id,true,kind,mode,
        effective_date,form_id,employ_type,'快照备注'
      FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${aIds[1]}::uuid`);
    // A 的在途调动申请（未落地，只有载荷）
    const pending = randomUUID();
    await tx.execute(sql`INSERT INTO employment_business_objects (id,tenant_id,employee_id)
      VALUES (${pending},${tenantId},${a})`);
    await tx.execute(sql`INSERT INTO employment_payload_versions
      (id,tenant_id,employee_id,business_id,version_no,kind,mode,effective_date,form_id,selected_staff_id)
      VALUES (gen_random_uuid(),${tenantId},${a},${pending},1,'transfer','application','2026-12-01','standard',
        ${aStaff})`);
    // 合同试用期：只有 A 的当前周期有，B、C 没有试用期
    const [type, company, contract] = [randomUUID(), randomUUID(), randomUUID()];
    await tx.execute(
      sql`INSERT INTO contract_types (id,tenant_id,code,name) VALUES (${type},${tenantId},'t','劳动合同')`,
    );
    await tx.execute(sql`INSERT INTO contract_companies (id,tenant_id,code,name)
      VALUES (${company},${tenantId},'c','合成法人公司')`);
    await tx.execute(sql`INSERT INTO contract_records
      (id,tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,probation_start_date,
       probation_end_date,signing_count,root_contract_id,version_no,created_by)
      VALUES (${contract},${tenantId},${a},'HT-BACKFILL-1',${type},${company},'fixed','2025-01-01','2028-01-01',
        '2025-01-01','2025-06-30',1,${contract},1,${session.user.id})`);
    // D：实习期合同带试用期（实习生仍记正式）；实习转正后签的合同带试用期（转正记录按入职处理为试用）
    for (const [number, start, end, probationEnd] of [
      ['HT-INTERN-D', '2025-01-01', '2025-06-30', '2025-03-31'],
      ['HT-REGULAR-D', '2025-07-01', '2028-06-30', '2025-12-31'],
    ] as const) {
      const id = randomUUID();
      await tx.execute(sql`INSERT INTO contract_records
        (id,tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,probation_start_date,
         probation_end_date,signing_count,root_contract_id,version_no,created_by)
        VALUES (${id},${tenantId},${d},${number},${type},${company},'fixed',${start},${end},${start},
          ${probationEnd},1,${id},1,${session.user.id})`);
    }
    return { aIds, bIds, cIds, dIds, eIds, pending };
  });
  const before = await withTenant(handle.db, tenantId, (tx) => snapshot(tx, tenantId));
  await handle.migrate();
  const after = await withTenant(handle.db, tenantId, (tx) => snapshot(tx, tenantId));
  expect(after).toEqual(before);
  const statuses = await withTenant(handle.db, tenantId, async (tx) => {
    const records = rows<{ id: string; s: number; e: number | null }>(
      await tx.execute(sql`SELECT id, employee_status AS s, entry_status AS e FROM employment_records
        WHERE tenant_id=${tenantId}`),
    );
    const payloads = rows<{ business: string; v: number; s: number }>(
      await tx.execute(sql`SELECT business_id AS business, version_no AS v, employee_status AS s
        FROM employment_payload_versions WHERE tenant_id=${tenantId}`),
    );
    return { records: new Map(records.map((r) => [r.id, r])), payloads };
  });
  const record = (id: string) => statuses.records.get(id)?.s;
  expect(ids.aIds.map(record)).toEqual([2, 2, 3, 3]);
  expect(ids.bIds.map(record)).toEqual([3, 8, 3]);
  expect(ids.cIds.map(record)).toEqual([3, 6]);
  // DEC-234 ②：实习生一律记正式；① 实习转正按入职处理（有试用期合同为试用，否则正式），之后继承
  expect(ids.dIds.map(record)).toEqual([3, 3, 2, 2]);
  expect(ids.eIds.map(record)).toEqual([3, 3]);
  expect([...statuses.records.values()].every((r) => r.e === null)).toBe(true);
  const payload = (business: string, v: number) =>
    statuses.payloads.find((row) => row.business === business && row.v === v)?.s;
  expect(payload(ids.aIds[1]!, 1)).toBe(2);
  expect(payload(ids.aIds[1]!, 2)).toBe(2);
  expect(payload(ids.aIds[2]!, 1)).toBe(3);
  expect(payload(ids.pending, 1)).toBe(3);
  expect(payload(ids.bIds[1]!, 1)).toBe(8);
});
