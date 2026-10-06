/** DEC-207 更正：组织导入采用与单条变更相同的任职选择，整批提交。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';

const database = useTestDb();
async function setup(label: string) {
  const world = await orgPeopleWorld(database().db, label);
  const root = await world.org('导入组织');
  const child = await world.org('导入下级', root.id);
  const person = await world.hire('本级员工', { departmentId: root.id });
  const subordinate = await world.hire('下级员工', { departmentId: child.id });
  const row = {
    sourceCode: root.id,
    orgId: root.id,
    code: root.code,
    name: '导入更名',
    parentId: world.tenant.id,
    expectedRevision: root.revision,
    startDate: '2026-10-09',
  };
  const send = (rows: object[], key = randomUUID()) =>
    world.call('POST', 'org/import', {
      ifMatch: 0,
      idempotencyKey: key,
      body: { rows },
    });
  return { world, root, child, person, subordinate, row, send };
}

it('AC-ORG-33 导入选是联动本级和下级，排除离职；幂等、审计和 outbox', async () => {
  const { world, person, subordinate, root, row, send } = await setup('org33yes');
  const left = await world.hire('已离职', { departmentId: root.id });
  await world.business(
    left.id,
    {
      kind: 'leave',
      mode: 'direct',
      effectiveDate: '2026-10-08',
      lastWorkDate: '2026-10-07',
    },
    left.revision,
  );
  const rows = [{ ...row, addEmployment: true }];
  const key = randomUUID();
  const first = await send(rows, key);
  expect(first.status, await first.clone().text()).toBe(200);
  const replay = await send(rows, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(await first.json());
  for (const employee of [person, subordinate]) {
    const records = await world.records(employee.id, '2026-10-09');
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.kind === 'hire')?.stopDate).toBe('2026-10-08');
    const adjustment = records.find((r) => r.kind === 'org_adjustment')!;
    expect(adjustment).toMatchObject({ effectiveDate: '2026-10-09', isCurrent: true });
    await withTenant(database().db, world.tenant.id, async (tx) => {
      expect(
        resultRows(
          await tx.execute(sql`SELECT id FROM audit_events
        WHERE command_id=${key} AND object_id=${adjustment.id}`),
        ).length,
      ).toBeGreaterThan(0);
      expect(
        resultRows(
          await tx.execute(sql`SELECT id FROM employment_outbox
        WHERE command_id=${key} AND business_id=${adjustment.id}::uuid`),
        ).length,
      ).toBeGreaterThan(0);
    });
  }
  expect((await world.records(left.id)).some((r) => r.kind === 'org_adjustment')).toBe(false);
});

it.each([false, undefined, true])('AC-ORG-33 不改名/上级的行不受控制项影响（%s）', async (addEmployment) => {
  const { world, root, person, row, send } = await setup(`org33unchanged${addEmployment}`);
  const before = await world.records(person.id);
  const response = await send([{ ...row, name: root.name, ...(addEmployment === undefined ? {} : { addEmployment }) }]);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await world.records(person.id)).toEqual(before);
});

it('AC-ORG-33 选否任职不动；只改行政上级也必须选择', async () => {
  const { world, root, person, row, send } = await setup('org33no');
  const other = await world.org('新上级');
  const before = await world.records(person.id);
  const missing = await send([{ ...row, name: root.name, parentId: other.id }]);
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: { details: { rowIndex: 0, sourceCode: row.sourceCode } } });
  const no = await send([{ ...row, parentId: other.id, addEmployment: false }]);
  expect(no.status, await no.clone().text()).toBe(200);
  expect(await world.records(person.id)).toEqual(before);
});

it('AC-ORG-33 缺填返回行级错误并回滚此前组织版本、任职、审计、outbox 和导入映射', async () => {
  const { world, root, child, person, row, send } = await setup('org33atomic');
  const key = randomUUID();
  const response = await send(
    [
      { ...row, addEmployment: true },
      { ...row, sourceCode: child.id, orgId: child.id, code: child.code, name: '下级更名', parentId: root.id },
    ],
    key,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      code: 'VALIDATION_FAILED',
      details: {
        rowIndex: 1,
        sourceCode: child.id,
        fields: { addEmployment: expect.any(String) },
      },
    },
  });
  expect((await world.orgsAt('2026-10-09')).get(root.id)).toMatchObject({ name: root.name, revision: 1 });
  expect(await world.records(person.id)).toHaveLength(1);
  await withTenant(database().db, world.tenant.id, async (tx) => {
    for (const table of ['audit_events', 'employment_outbox', 'org_import_results']) {
      expect(resultRows(await tx.execute(sql`SELECT id FROM ${sql.raw(table)} WHERE command_id=${key}`))).toEqual([]);
    }
    expect(resultRows(await tx.execute(sql`SELECT source_code FROM org_import_mappings`))).toEqual([]);
  });
});

it('AC-ORG-33 同批先迁入子树再更名，联动人员在组织锁之前统一预锁', async () => {
  const { world, root, child, person, subordinate, row, send } = await setup('org33move');
  const target = await world.org('目标树');
  const response = await send([
    { ...row, name: root.name, parentId: target.id, addEmployment: false },
    { ...row, sourceCode: target.id, orgId: target.id, code: target.code, name: '目标树改名', addEmployment: true },
  ]);
  expect(response.status, await response.clone().text()).toBe(200);
  for (const employee of [person, subordinate]) expect(await world.records(employee.id)).toHaveLength(2);
  expect((await world.orgsAt('2026-10-09')).get(child.id)?.name).toBe(child.name);
});
