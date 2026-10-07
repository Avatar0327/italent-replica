/** astra R3-P2-01：F-006 初始载荷自身的经理变更不能随迟到调动的继承值一并撤回。 */
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';
import { versions } from './AC-JOB-sequence-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
it.each(['F-006', 'F-006→F-007', 'F-007'])('AC-ORG-32 迟到重建保留初始独立变更（%s）', async (entry) => {
  const db = database().db;
  const w = await orgPeopleWorld(db, `org32manager${entry}`);
  const org = await w.org('部门');
  const post = await w.job('posts', '职务');
  const parent = await w.job('positions', '新上级职位', { orgId: org.id, postId: post.id });
  const position = await w.job('positions', '员工职位', { orgId: org.id, postId: post.id });
  const manager = await w.hire('经理 M', { departmentId: org.id, positionId: parent.id });
  const person = await w.hire('员工', {
    departmentId: org.id,
    positionId: position.id,
    place: '原工作地点',
    directManagerId: null,
  });
  const transfer = await w.business(
    person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { place: '调动工作地点' },
    },
    person.revision,
  );
  if (entry !== 'F-007') {
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
  if (entry !== 'F-006') {
    const changed = await w.patchOrg(org, { name: '部门改名', effectiveDate: '2026-10-09', addEmployment: true });
    expect(changed.status, await changed.clone().text()).toBe(200);
  }
  const expectedManager = entry === 'F-007' ? null : manager.id;
  const adjustments = (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
  expect(adjustments).toHaveLength(entry === 'F-006→F-007' ? 2 : 1);
  for (const record of adjustments)
    expect(record.fields).toMatchObject({ directManagerId: expectedManager, place: '调动工作地点' });
  const originals = () =>
    withTenant(db, w.tenant.id, async (tx) =>
      resultRows(
        await tx.execute(sql`
    SELECT p.id,p.direct_manager_id,p.place,p.explicit_field_codes
    FROM employment_payload_versions p JOIN employment_records r ON r.tenant_id=p.tenant_id AND r.id=p.business_id
    WHERE p.tenant_id=${w.tenant.id} AND p.employee_id=${person.id}::uuid AND p.version_no=1 AND r.kind='org_adjustment'
    ORDER BY p.id`),
      ),
    );
  const before = await originals();
  const run = () =>
    runEmploymentActivations(
      db,
      cmd(),
      { tenantId: w.tenant.id },
      {
        clock: () => new Date('2026-10-10T01:00:00Z'),
      },
    );
  expect((await run()).runs[0]).toMatchObject({ failed: [], errors: [] });
  const restored = (await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment');
  expect(restored.map((r) => r.id)).toEqual(adjustments.map((r) => r.id));
  for (const record of restored)
    expect.soft(record.fields).toMatchObject({ directManagerId: expectedManager, place: '原工作地点' });
  expect((await w.records(person.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: transfer.id,
    effectiveDate: '2026-10-10',
    fields: { place: '调动工作地点' },
  });
  expect(await originals()).toEqual(before);
  const after = await versions(db, w.tenant.id, person.id);
  for (const record of adjustments) expect(after.find((p) => p.businessId === record.id)?.count).toBe(2);
  expect((await run()).runs[0]).toMatchObject({ failed: [], errors: [] });
  expect(await versions(db, w.tenant.id, person.id)).toEqual(after);
});
