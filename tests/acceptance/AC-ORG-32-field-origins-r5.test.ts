/** astra R4-P2-01：本业务输入/派生与前驱继承不能混为一类，连续联动也不能传播回退值。 */
import { runEmploymentActivations } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld } from './AC-ORG-people-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const cases = ['sequenceId', 'levelId', 'gradeId'].flatMap((field) =>
  ['single', 'F-007', 'F-006→F-007'].flatMap((chain) => [false, true].map((explicit) => ({ field, chain, explicit }))),
);
it.each(cases)('AC-ORG-32 字段来源 $field / $chain / 同值显式=$explicit', async ({ field, chain, explicit }) => {
  const db = database().db;
  const w = await orgPeopleWorld(db, `origins${field}${chain}${explicit}`);
  const org = await w.org('部门');
  const a = await w.job(
    field === 'sequenceId' ? 'sequences' : field === 'levelId' ? 'levels' : 'grades',
    'A',
    field === 'levelId' ? { level: 1 } : field === 'gradeId' ? { grade: 1 } : {},
  );
  const b = await w.job(
    field === 'sequenceId' ? 'sequences' : field === 'levelId' ? 'levels' : 'grades',
    'B',
    field === 'levelId' ? { level: 2 } : field === 'gradeId' ? { grade: 2 } : {},
  );
  const postA = await w.job('posts', '职务 A', field === 'sequenceId' ? { sequenceId: a.id } : {});
  const postB = await w.job('posts', '职务 B', field === 'sequenceId' ? { sequenceId: b.id } : {});
  const parent = await w.job('positions', '上级职位', { orgId: org.id, postId: postA.id });
  const position = await w.job('positions', '员工职位', { orgId: org.id, postId: postB.id });
  const manager = await w.hire('经理', { departmentId: org.id, positionId: parent.id });
  const person = await w.hire('员工', {
    departmentId: org.id,
    positionId: null,
    postId: postA.id,
    [field]: a.id,
    place: '原地点',
  });
  await w.business(
    person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { place: '调动地点', ...(field === 'sequenceId' ? {} : { [field]: b.id }) },
    },
    person.revision,
  );
  const employee = await w.call('GET', `employment/employees/${person.id}`);
  const revision = ((await employee.json()) as { revision: number }).revision;
  const created = await w.request('POST', `/employees/${person.id}/businesses`, {
    ifMatch: revision,
    body: {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-09',
      fields: { positionId: position.id, postId: postB.id, ...(explicit ? { [field]: b.id } : {}) },
    },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  if (chain === 'F-006→F-007') {
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
  if (chain !== 'single') {
    const changed = await w.patchOrg(org, { name: '新名称', effectiveDate: '2026-10-09', addEmployment: true });
    expect(changed.status, await changed.clone().text()).toBe(200);
  }
  const result = await runEmploymentActivations(
    db,
    cmd(),
    { tenantId: w.tenant.id },
    {
      clock: () => new Date('2026-10-10T01:00:00Z'),
    },
  );
  expect(result.runs[0]).toMatchObject({ failed: [], errors: [] });
  const records = (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
  expect(records).toHaveLength(chain === 'single' ? 1 : chain === 'F-007' ? 2 : 3);
  for (const [index, record] of records.entries()) {
    expect.soft(record.fields).toMatchObject({
      postId: postB.id,
      place: '原地点',
      [field]: field === 'sequenceId' || explicit ? b.id : a.id,
      ...(chain === 'F-006→F-007' && index > 0 ? { directManagerId: manager.id } : {}),
    });
  }
});

it.each([false, true].flatMap((explicit) => [false, true].map((chain) => ({ explicit, chain }))))(
  'AC-ORG-32 职位引用恢复后经理按原派生规则重算 / 同值显式=$explicit / 后续F-007=$chain',
  async ({ explicit, chain }) => {
    const db = database().db;
    const w = await orgPeopleWorld(db, `managerReference${explicit}${chain}`);
    const org = await w.org('部门');
    const post = await w.job('posts', '职务');
    const parentA = await w.job('positions', '上级 A', { orgId: org.id, postId: post.id });
    const parentB = await w.job('positions', '上级 B', { orgId: org.id, postId: post.id });
    const positionA = await w.job('positions', '职位 A', {
      orgId: org.id,
      postId: post.id,
      parents: { admin: { parentId: parentA.id } },
    });
    const positionB = await w.job('positions', '职位 B', { orgId: org.id, postId: post.id });
    const managerA = await w.hire('经理 A', { departmentId: org.id, positionId: parentA.id });
    const managerB = await w.hire('经理 B', { departmentId: org.id, positionId: parentB.id });
    const person = await w.hire('员工', {
      departmentId: org.id,
      positionId: positionA.id,
      directManagerId: managerA.id,
      place: '原地点',
    });
    await w.business(
      person.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { positionId: positionB.id, place: '调动地点' },
      },
      person.revision,
    );
    if (explicit) {
      await w.business(
        person.id,
        {
          kind: 'org_adjustment',
          mode: 'direct',
          effectiveDate: '2026-10-09',
          fields: { directManagerId: managerB.id },
        },
        (await w.getEmployee(person.id)).revision,
      );
    } else {
      const changed = await w.call('PATCH', `job/positions/${positionB.id}`, {
        ifMatch: positionB.revision,
        body: {
          parents: { admin: { parentId: parentB.id } },
          effectiveDate: '2026-10-09',
          adjustEmployeeDirectManager: true,
        },
      });
      expect(changed.status, await changed.clone().text()).toBe(200);
    }
    if (chain) {
      const changed = await w.patchOrg(org, { name: '新名称', effectiveDate: '2026-10-09', addEmployment: true });
      expect(changed.status, await changed.clone().text()).toBe(200);
    }
    expect(
      (
        await runEmploymentActivations(
          db,
          cmd(),
          { tenantId: w.tenant.id },
          {
            clock: () => new Date('2026-10-10T01:00:00Z'),
          },
        )
      ).runs[0],
    ).toMatchObject({ failed: [], errors: [] });
    const adjustments = (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
    expect(adjustments).toHaveLength(chain ? 2 : 1);
    for (const record of adjustments)
      expect.soft(record.fields).toMatchObject({
        positionId: positionA.id,
        directManagerId: explicit ? managerB.id : managerA.id,
        place: '原地点',
      });
  },
);

it.each([false, true].flatMap((explicit) => [false, true].map((chain) => ({ explicit, chain }))))(
  'AC-ORG-32 部门负责人带出属于调动来源 / 同值显式=$explicit / 后续F-007=$chain',
  async ({ explicit, chain }) => {
    const db = database().db;
    const w = await orgPeopleWorld(db, `departmentManager${explicit}${chain}`);
    const a = await w.org('A 部门');
    const b = await w.org('B 部门');
    const manager = await w.hire('B 负责人', { departmentId: b.id });
    const head = await w.patchOrg(b, { personInChargeId: manager.id, effectiveDate: '2026-10-01' });
    expect(head.status, await head.clone().text()).toBe(200);
    const person = await w.hire('员工', { departmentId: a.id, directManagerId: null });
    const transfer = await w.business(
      person.id,
      {
        kind: 'transfer',
        mode: 'direct',
        formId: 'TenantBase.TransferMultiFormView',
        effectiveDate: '2026-10-05',
        fields: { departmentId: b.id },
      },
      person.revision,
    );
    const adjustment = await w.business(
      person.id,
      {
        kind: 'org_adjustment',
        mode: 'direct',
        effectiveDate: '2026-10-09',
        fields: { remarks: '独立组织调整', ...(explicit ? { directManagerId: manager.id } : {}) },
      },
      (await w.getEmployee(person.id)).revision,
    );
    expect(adjustment.record?.fields.directManagerId).toBe(manager.id);
    if (chain) {
      const changed = await w.patchOrg((await head.json()) as { id: string; revision: number }, {
        name: 'B 改名',
        effectiveDate: '2026-10-09',
        addEmployment: true,
      });
      expect(changed.status, await changed.clone().text()).toBe(200);
    }
    expect(
      (
        await runEmploymentActivations(
          db,
          cmd(),
          { tenantId: w.tenant.id },
          {
            clock: () => new Date('2026-10-10T01:00:00Z'),
          },
        )
      ).runs[0],
    ).toMatchObject({ failed: [], errors: [] });
    const adjustments = (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
    expect(adjustments).toHaveLength(chain ? 2 : 1);
    for (const record of adjustments)
      expect.soft(record.fields).toMatchObject({
        departmentId: a.id,
        directManagerId: explicit ? manager.id : null,
        remarks: '独立组织调整',
      });
    expect((await w.records(person.id, '2026-10-10')).find((r) => r.id === transfer.id)?.fields.directManagerId).toBe(
      manager.id,
    );
  },
);

it.each([false, true])('AC-ORG-32 有效历史已明确序列时不二次派生覆盖 / 后续F-007=%s', async (chain) => {
  const db = database().db;
  const w = await orgPeopleWorld(db, `validSequence${chain}`);
  const org = await w.org('部门');
  const b = await w.job('sequences', 'S_B');
  const c = await w.job('sequences', 'S_C');
  const x = await w.job('sequences', '人工 S_X');
  const postB = await w.job('posts', '职务 B', { sequenceId: b.id });
  const postC = await w.job('posts', '职务 C', { sequenceId: c.id });
  const person = await w.hire('员工', { departmentId: org.id, postId: postB.id, place: '原地点' });
  await w.business(
    person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { place: '迟到地点' },
    },
    person.revision,
  );
  await w.business(
    person.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-09',
      fields: { postId: postB.id },
    },
    (await w.getEmployee(person.id)).revision,
  );
  if (chain) {
    expect((await w.patchOrg(org, { name: '新名称', effectiveDate: '2026-10-09', addEmployment: true })).status).toBe(
      200,
    );
  }
  // 第二笔在计划日直接执行；第一笔仍未执行，不能把第二笔的有效传播也撤回或重新自动带出。
  w.setNow('2026-10-06T01:00:00Z');
  await w.business(
    person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-06',
      fields: { postId: postC.id, sequenceId: x.id },
    },
    (await w.getEmployee(person.id)).revision,
  );
  for (const record of (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment'))
    expect(record.fields).toMatchObject({ postId: postC.id, sequenceId: x.id });
  expect(
    (
      await runEmploymentActivations(
        db,
        cmd(),
        { tenantId: w.tenant.id },
        {
          clock: () => new Date('2026-10-10T01:00:00Z'),
        },
      )
    ).runs[0],
  ).toMatchObject({ failed: [], errors: [] });
  const adjustments = (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
  expect(adjustments).toHaveLength(chain ? 2 : 1);
  for (const record of adjustments)
    expect.soft(record.fields).toMatchObject({
      postId: postC.id,
      sequenceId: x.id,
    });
});
