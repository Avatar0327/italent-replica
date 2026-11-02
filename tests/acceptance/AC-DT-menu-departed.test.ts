/**
 * R2-T09a 检查离职退休人员的规模与分页（第 2 轮返工 P2-6 / Claude P3-4；DEC-726）。
 * “仍承担职责”在分页前过滤，total 按完整过滤集计；page / pageSize 分页，排序稳定（生效日倒序、员工 ID 升序）。
 * 1000 余名离职人员经 SQL 批量复制一名已离职的合成员工造出（jsonb_populate_record 逐表复制，租户事务内写入）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { menuWorld, type MenuWorld } from './AC-DT-menu-support.js';

const database = useTestDb();
const TODAY = '2026-10-20';

interface Clone {
  readonly eid: string;
  readonly sid: string;
  readonly bid: string;
  readonly pvid: string;
  readonly oid: string;
  readonly vid: string;
  readonly code: string;
}

/**
 * 复制已离职员工 baseId（其离职业务 exitId）count 份；orgId 非空时每份再复制一个由该份担任负责人的组织（= 仍有职责）。
 */
async function cloneDeparted(
  x: MenuWorld,
  base: { id: string; exitId: string; orgId: string | null },
  count: number,
  prefix: string,
) {
  const db = database().db;
  const tenant = x.session.tenant.id;
  const mapping: Clone[] = Array.from({ length: count }, (_, i) => ({
    eid: randomUUID(),
    sid: randomUUID(),
    bid: randomUUID(),
    pvid: randomUUID(),
    oid: randomUUID(),
    vid: randomUUID(),
    code: `${prefix}_${i}`,
  }));
  await withTenant(db, tenant, async (tx) => {
    const map = sql`jsonb_to_recordset(${JSON.stringify(mapping)}::jsonb)
      AS m(eid uuid, sid uuid, bid uuid, pvid uuid, oid uuid, vid uuid, code text)`;
    const copy = (table: string, where: ReturnType<typeof sql>, changes: string) =>
      tx.execute(sql`INSERT INTO ${sql.raw(table)}
        SELECT (jsonb_populate_record(NULL::${sql.raw(table)}, to_jsonb(b) || ${sql.raw(changes)})).*
        FROM ${sql.raw(table)} b CROSS JOIN ${map} WHERE ${where}`);
    const exit = sql`b.tenant_id=${tenant} AND b.id=${base.exitId}::uuid`;
    await copy(
      'employment_employees',
      sql`b.tenant_id=${tenant} AND b.id=${base.id}::uuid`,
      "jsonb_build_object('id',m.eid,'code',m.code,'name',m.code)",
    );
    await copy(
      'employment_cycles',
      sql`b.tenant_id=${tenant} AND b.employee_id=${base.id}::uuid`,
      "jsonb_build_object('id',m.sid,'employee_id',m.eid)",
    );
    await copy('employment_business_objects', exit, "jsonb_build_object('id',m.bid,'employee_id',m.eid)");
    await copy(
      'employment_payload_versions',
      sql`b.tenant_id=${tenant} AND b.id=(SELECT payload_version_id FROM employment_records
        WHERE tenant_id=${tenant} AND id=${base.exitId}::uuid)`,
      `jsonb_build_object('id',m.pvid,'employee_id',m.eid,'business_id',m.bid,'version_no',1,
        'previous_version_id',NULL,'trigger_business_id',NULL,'command_id',NULL,'is_record_snapshot',false,
        'selected_staff_id',m.sid,'source_record_id',NULL,'source_staff_id',NULL,'job_number',m.code)`,
    );
    await tx.execute(sql`INSERT INTO employment_state_events(tenant_id,id,employee_id,business_id,payload_version_id,
        state,event_no,command_id)
      SELECT ${tenant}, gen_random_uuid(), m.eid, m.bid, m.pvid, 'effective', 1, ${`clone-${prefix}`} FROM ${map}`);
    await copy(
      'employment_records',
      exit,
      `jsonb_build_object('id',m.bid,'employee_id',m.eid,'payload_version_id',m.pvid,'staff_id',m.sid,
        'inheritance_source_id',NULL,'job_number',m.code)`,
    );
    await copy(
      'employment_timeline',
      sql`b.tenant_id=${tenant} AND b.record_id=${base.exitId}::uuid`,
      "jsonb_build_object('employee_id',m.eid,'record_id',m.bid,'staff_id',m.sid)",
    );
    if (!base.orgId) return;
    await copy(
      'org_objects',
      sql`b.tenant_id=${tenant} AND b.id=${base.orgId}::uuid`,
      "jsonb_build_object('id',m.oid,'revision',1)",
    );
    const latest = sql`SELECT id FROM org_versions WHERE tenant_id=${tenant} AND org_id=${base.orgId}::uuid
      ORDER BY version_no DESC LIMIT 1`;
    await copy(
      'org_versions',
      sql`b.tenant_id=${tenant} AND b.id=(${latest})`,
      `jsonb_build_object('id',m.vid,'org_id',m.oid,'version_no',1,'previous_version_id',NULL,
        'person_in_charge_id',m.eid,'code',m.code,'name',m.code,'full_name',m.code)`,
    );
    await copy(
      'org_hierarchy_links',
      sql`b.tenant_id=${tenant} AND b.version_id=(${latest})`,
      "jsonb_build_object('version_id',m.vid)",
    );
  });
  return mapping.map((row) => row.eid);
}

describe('检查离职退休人员：规模与分页（P2-6）', () => {
  it('1000 余名有职责的离职人员混有无职责者：total 准确，分页不重不漏、排序稳定，按范围过滤', async () => {
    const x = await menuWorld(database().db, 'departed-scale', TODAY);
    const holder = await x.peer('合成离职负责人');
    const org = await x.session.org('合成职责组织', { establishedOn: '2026-01-01' });
    await x.setHead(org.id, holder.id);
    const idle = await x.peer('合成无职责离职');
    const holderExit = await x.effectiveExit(holder.id, '2026-10-01');
    const idleExit = await x.effectiveExit(idle.id, '2026-10-01');

    // 无职责的先造，避免“先截断再过滤”的实现碰巧按插入顺序取到全部有职责者。
    const idleClones = await cloneDeparted(x, { id: idle.id, exitId: idleExit.id, orgId: null }, 400, 'IDLE');
    const holders = [
      holder.id,
      ...(await cloneDeparted(x, { id: holder.id, exitId: holderExit.id, orgId: org.id }, 1000, 'CAP')),
    ];

    const first = await x.departed('page=1&pageSize=200');
    expect(first.total).toBe(1001);
    expect(first.items).toHaveLength(200);
    const seen: string[] = [];
    for (let page = 1; page <= 6; page += 1) {
      const listed = await x.departed(`page=${page}&pageSize=200`);
      expect(listed.total).toBe(1001);
      seen.push(...listed.items.map((row) => row.employeeId));
    }
    expect(seen).toHaveLength(1001);
    expect(new Set(seen).size).toBe(1001);
    expect([...seen].sort()).toEqual([...holders].sort());
    // 同一离职日内按员工 ID 升序（与 PG uuid 比较一致：小写十六进制按字典序）。
    expect(seen).toEqual([...seen].sort());
    expect(seen.some((id) => idleClones.includes(id) || id === idle.id)).toBe(false);
    expect((await x.departed('page=7&pageSize=200')).items).toEqual([]);

    const visible = [holders[3]!, holders[500]!, idleClones[0]!];
    const scoped = await x.departed('', x.scopedRequest(visible));
    expect(scoped.total).toBe(2);
    expect(scoped.items.map((row) => row.employeeId).sort()).toEqual([holders[3], holders[500]].sort());
    expect(scoped.items[0]).not.toHaveProperty('sort');
    // 1400 名克隆人员 + 7 次翻页：PGlite 长跑串行时单条可达 2 分钟以上，放宽到 5 分钟。
  }, 300_000);

  it('默认分页：未带页码时返回第一页（每页 50），total 仍为完整数量', async () => {
    const x = await menuWorld(database().db, 'departed-default', TODAY);
    const holder = await x.peer('合成离职负责人');
    const org = await x.session.org('合成职责组织', { establishedOn: '2026-01-01' });
    await x.setHead(org.id, holder.id);
    const exit = await x.effectiveExit(holder.id, '2026-10-01');
    await cloneDeparted(x, { id: holder.id, exitId: exit.id, orgId: org.id }, 59, 'PAGE');

    const listed = await x.departed();
    expect(listed.total).toBe(60);
    expect(listed.items).toHaveLength(50);
    expect((await x.departed('page=2')).items).toHaveLength(10);
  }, 60_000);
});
