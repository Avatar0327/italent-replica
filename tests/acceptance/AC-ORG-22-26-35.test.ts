/** F-007 / DEC-137：组织变更与任职链在一个命令事务中提交。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';

const testDb = useTestDb();
const DATE = '2026-10-08';
async function setup(label: string) {
  const world = await orgPeopleWorld(testDb().db, label);
  const root = await world.org('组织甲');
  const child = await world.org('下级乙', root.id);
  const other = await world.org('组织丙');
  const employee = await world.hire('本组织员工', { departmentId: root.id, remarks: '保留业务值' });
  const subordinate = await world.hire('下级员工', { departmentId: child.id });
  return { world, root, child, other, employee, subordinate };
}

describe('AC-ORG-22～26、35 组织调整任职联动', () => {
  it('AC-ORG-35 改名/行政上级必须显式选择；其他变更不接受该选项', async () => {
    const { world, root, other } = await setup('org21');
    for (const patch of [{ name: '新名称' }, { parents: { admin: { parentId: other.id } } }]) {
      const response = await world.patchOrg(root, { effectiveDate: DATE, ...patch });
      expect(response.status).toBe(400);
    }
    expect((await world.patchOrg(root, { effectiveDate: DATE, remarks: '备注', addEmployment: true })).status).toBe(
      400,
    );
    expect((await world.patchOrg(root, { effectiveDate: DATE, remarks: '备注' })).status).toBe(200);
  });

  it('AC-ORG-22 是：本组织与下级各追加直接生效的组织调整，原记录截至前一天；离职/外部门不追加', async () => {
    const { world, root, other, employee, subordinate } = await setup('org22');
    const left = await world.hire('离职员工', { departmentId: root.id });
    await world.business(
      left.id,
      { kind: 'leave', mode: 'direct', effectiveDate: '2026-10-07', lastWorkDate: '2026-10-06' },
      left.revision,
    );
    const outside = await world.hire('外部门员工', { departmentId: other.id });
    const response = await world.patchOrg(root, { effectiveDate: DATE, name: '组织甲新', addEmployment: true });
    expect(response.status, await response.clone().text()).toBe(200);
    for (const person of [employee, subordinate]) {
      const records = await world.employmentRecords(person.id, DATE);
      expect(records).toHaveLength(2);
      expect(records.find((r) => r.kind === 'hire')?.stopDate).toBe('2026-10-07');
      expect(records.find((r) => r.kind === 'org_adjustment')).toMatchObject({
        effectiveDate: DATE,
        status: 'effective',
        changeType: null,
        isCurrent: true,
      });
    }
    expect(await world.records(left.id, DATE)).toHaveLength(2);
    expect(await world.records(outside.id, DATE)).toHaveLength(1);
  });

  it('AC-ORG-22 否：组织变更成功，所有任职记录不动', async () => {
    const { world, root, employee, subordinate } = await setup('org22no');
    const before = await Promise.all([world.records(employee.id), world.records(subordinate.id)]);
    const response = await world.patchOrg(root, { effectiveDate: DATE, name: '仅改名', addEmployment: false });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await Promise.all([world.records(employee.id), world.records(subordinate.id)])).toEqual(before);
  });

  it('AC-ORG-23 插在未来记录之前，不覆盖其业务字段；行政上级按记录日期解析', async () => {
    const { world, root, child, other, subordinate } = await setup('org23');
    const future = await world.business(
      subordinate.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-15',
        fields: { remarks: '未来字段', place: '未来地点' },
      },
      subordinate.revision,
    );
    const before = await world.record(future.id, '2026-10-15');
    const response = await world.patchOrg(root, {
      effectiveDate: DATE,
      parents: { admin: { parentId: other.id } },
      addEmployment: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const records = await world.records(subordinate.id, DATE);
    expect(records).toHaveLength(3);
    expect(records.find((r) => r.kind === 'org_adjustment')).toMatchObject({
      effectiveDate: DATE,
      stopDate: '2026-10-14',
      isInserted: true,
      fields: { departmentId: child.id },
    });
    const after = await world.record(future.id, '2026-10-15');
    expect(after.fields).toEqual(before.fields);
    expect(after.customFields).toEqual(before.customFields);
    expect(after.id).toBe(before.id);
    const orgs = await world.orgsAt('2026-10-15');
    expect(orgs.get(child.id)?.fullName).toContain('组织丙/组织甲/下级乙');
  });

  it('AC-ORG-24 同日已有记录按 DEC-108 操作顺序追加，前记录保留且不再当前', async () => {
    const { world, root, employee } = await setup('org24');
    const prior = await world.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: DATE,
        fields: { remarks: '同日调动值' },
      },
      employee.revision,
    );
    const response = await world.patchOrg(root, { effectiveDate: DATE, name: '同日改名', addEmployment: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const records = await world.records(employee.id, DATE);
    const adjusted = records.find((r) => r.kind === 'org_adjustment');
    expect(adjusted).toMatchObject({ previousRecordId: prior.id, isCurrent: true, fields: { remarks: '同日调动值' } });
    expect(records.find((r) => r.id === prior.id)?.isCurrent).toBe(false);
  });

  it('AC-ORG-25 重复提交幂等，同键异内容冲突；审计及 outbox 与新记录同命令落库', async () => {
    const { world, root, employee } = await setup('org25');
    const key = randomUUID();
    const body = { effectiveDate: DATE, name: '幂等改名', addEmployment: true };
    const send = (value = body) =>
      world.call('PATCH', `org/organizations/${root.id}`, {
        ifMatch: root.revision,
        idempotencyKey: key,
        body: value,
      });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect((await send({ ...body, addEmployment: false })).status).toBe(409);
    const records = await world.records(employee.id, DATE);
    expect(records).toHaveLength(2);
    const id = records.find((r) => r.kind === 'org_adjustment')!.id;
    await withTenant(testDb().db, world.tenant.id, async (tx) => {
      const audit = resultRows(
        await tx.execute(sql`SELECT * FROM audit_events
        WHERE tenant_id=${world.tenant.id} AND command_id=${key} AND object_id=${id}`),
      );
      const outbox = resultRows(
        await tx.execute(sql`SELECT * FROM employment_outbox
        WHERE tenant_id=${world.tenant.id} AND command_id=${key} AND business_id=${id}::uuid`),
      );
      expect(audit.length).toBeGreaterThan(0);
      expect(outbox.length).toBeGreaterThan(0);
    });
  });

  it('AC-ORG-26 跨租户请求拒绝，两个租户的任职均不变', async () => {
    const a = await setup('org26a');
    const b = await setup('org26b');
    const response = await a.world.call('PATCH', `org/organizations/${b.root.id}`, {
      ifMatch: b.root.revision,
      body: { effectiveDate: DATE, name: '跨租户', addEmployment: true },
    });
    expect(response.status).toBe(404);
    expect(await a.world.records(a.employee.id)).toHaveLength(1);
    expect(await b.world.records(b.employee.id)).toHaveLength(1);
  });
});

it('AC-ORG-22 按变更生效日归属选人：未来调入者追加，提前调出者不追加', async () => {
  const { world, root, other, employee } = await setup('org22asof');
  const incoming = await world.hire('未来调入员工', { departmentId: other.id });
  for (const [person, departmentId] of [
    [employee, other.id],
    [incoming, root.id],
  ] as const) {
    await world.business(
      person.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId } },
      person.revision,
    );
  }
  const response = await world.patchOrg(root, { effectiveDate: DATE, name: '按日期改名', addEmployment: true });
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await world.records(employee.id, DATE)).some((r) => r.kind === 'org_adjustment')).toBe(false);
  expect((await world.records(incoming.id, DATE)).find((r) => r.kind === 'org_adjustment')).toMatchObject({
    effectiveDate: DATE,
    fields: { departmentId: root.id },
  });
});

it('AC-ORG-35 导入混合大小写 UUID 统一规范化，不将同一上级误判为变更', async () => {
  const { world, root, employee } = await setup('org35uuid');
  const response = await world.call('POST', 'org/import', {
    ifMatch: 0,
    body: {
      rows: [
        {
          sourceCode: 'UUID35',
          orgId: root.id.toUpperCase(),
          code: root.code,
          name: root.name,
          parentId: world.tenant.id.toUpperCase(),
          expectedRevision: root.revision,
          startDate: '2026-10-08',
        },
      ],
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await world.records(employee.id)).toHaveLength(1);
});
