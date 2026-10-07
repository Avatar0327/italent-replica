/**
 * astra R6-P2-03：迟到重建初始化前驱字段必须遵守 fields.ts / inheritance.ts 的继承矩阵——
 * 不继承的预置字段（isDepartmentHead / isStoreManager / addedSubordinateIds）与 inherit:false 的自定义字段
 * 在通用组织调整、F-006、F-006→F-007 上保持为空；纯 F-007 复制前驱（DEC-137 / `10` §17）仍复制。
 */
import { runEmploymentActivations } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld } from './AC-ORG-people-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
type Field = 'custom' | 'isDepartmentHead' | 'isStoreManager' | 'addedSubordinateIds';
type Chain = 'generic' | 'F-006' | 'F-006→F-007' | 'F-007';
const cases = (['custom', 'isDepartmentHead', 'isStoreManager', 'addedSubordinateIds'] as Field[]).flatMap((field) =>
  (['generic', 'F-006', 'F-006→F-007', 'F-007'] as Chain[]).map((chain) => ({ field, chain })),
);

it.each(cases)('AC-ORG-32 R6-P2-03 继承矩阵 / $field / $chain', async ({ field, chain }) => {
  const { db } = database();
  const w = await orgPeopleWorld(db, `r7matrix${field}${chain}`);
  const org = await w.org('矩阵部门');
  const post = await w.job('posts', '职务');
  const parent = await w.job('positions', '上级职位', { orgId: org.id, postId: post.id });
  const position = await w.job('positions', '员工职位', { orgId: org.id, postId: post.id });
  const manager = await w.hire('经理', { departmentId: org.id, positionId: parent.id });
  const subordinate = await w.hire('下属', { departmentId: org.id });
  let customId = '';
  if (field === 'custom') {
    const created = await w.request('POST', '/custom-fields', {
      ifMatch: 0,
      body: { name: '不继承文本', valueType: 'text', objectType: 'employment' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const definition = (await created.json()) as { id: string; revision: number };
    customId = definition.id;
    const off = await w.request('PUT', `/custom-fields/${customId}/inheritance`, {
      ifMatch: definition.revision,
      body: { inherit: false },
    });
    expect(off.status, await off.clone().text()).toBe(200);
  }
  const hireValue = field === 'custom' ? '前驱文本' : field === 'addedSubordinateIds' ? [subordinate.id] : true;
  const employee = await w.employee('员工');
  const hired = await w.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-10-01',
      fields: {
        employType: 'internal',
        departmentId: org.id,
        positionId: position.id,
        directManagerId: null,
        place: '原地点',
        ...(field === 'custom' ? {} : { [field]: hireValue }),
      },
      ...(field === 'custom' ? { customFields: { [customId]: hireValue } } : {}),
    },
    employee.revision,
  );
  const person = { id: employee.id, revision: hired.employeeRevision, recordId: hired.id };
  const read = (record: { fields: Record<string, unknown>; customFields?: Record<string, unknown> }) =>
    field === 'custom' ? (record.customFields?.[customId] ?? null) : record.fields[field];
  expect(read(await w.record(person.recordId, '2026-10-01'))).toEqual(hireValue);
  const transfer = await w.business(
    person.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { place: '调动地点' } },
    person.revision,
  );
  if (chain === 'generic') {
    await w.business(
      person.id,
      { kind: 'org_adjustment', mode: 'direct', effectiveDate: '2026-10-09', fields: { remarks: '通用组织调整' } },
      (await w.getEmployee(person.id)).revision,
    );
  }
  if (chain === 'F-006' || chain === 'F-006→F-007') {
    const changed = await w.call('PATCH', `job/positions/${position.id}`, {
      ifMatch: position.revision,
      body: {
        parents: { admin: { parentId: parent.id } },
        effectiveDate: '2026-10-09',
        adjustEmployeeDirectManager: true,
      },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
  }
  if (chain === 'F-006→F-007' || chain === 'F-007') {
    const renamed = await w.patchOrg(org, { name: '矩阵改名', effectiveDate: '2026-10-09', addEmployment: true });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
  }
  const expected = chain === 'F-007' ? hireValue : null;
  const adjustments = (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
  expect(adjustments).toHaveLength(chain === 'F-006→F-007' ? 2 : 1);
  // 调动记录按矩阵不继承这些字段，创建时的组织调整据此为空（纯 F-007 复制调动记录，同样为空）。
  for (const record of adjustments) expect(read(record)).toEqual(null);
  const result = await runEmploymentActivations(
    db,
    cmd(),
    { tenantId: w.tenant.id },
    { clock: () => new Date('2026-10-10T01:00:00Z') },
  );
  expect(result.runs[0]).toMatchObject({ failed: [], errors: [] });
  for (const record of adjustments) {
    const rebuilt = await w.record(record.id, '2026-10-09');
    expect.soft(read(rebuilt), `组织调整 ${record.id} 的 ${field}`).toEqual(expected);
    expect.soft(rebuilt.fields.place).toBe('原地点');
  }
  expect((await w.records(person.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({ id: transfer.id });
  expect(manager.id).toBeDefined();
});
