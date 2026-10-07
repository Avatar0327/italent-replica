/** astra R2-P2-02：序列自动同步依赖职务/职位引用，迟到重建不得把旧引用的派生值当作人工更正。 */
import { runEmploymentActivations } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld } from './AC-ORG-people-support.js';
import { callAt, worker, versions } from './AC-JOB-sequence-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
it.each([
  ['posts', false],
  ['posts', true],
  ['positions', false],
  ['positions', true],
] as const)('AC-ORG-37 迟到重建按引用恢复序列（来源=%s，先同步=%s）', async (kind, syncFirst) => {
  const db = database().db;
  const w = await orgPeopleWorld(db, `org37late${kind}${syncFirst}`);
  const org = await w.org('组合部门');
  const a = await w.job('sequences', 'S_A');
  const b = await w.job('sequences', 'S_B');
  const c = await w.job('sequences', 'S_C');
  const post = kind === 'positions' ? await w.job('posts', '职位对应职务', { sequenceId: a.id }) : null;
  const extra = post ? { orgId: org.id, postId: post.id } : {};
  const sourceA = await w.job(kind, 'A', { ...extra, sequenceId: a.id });
  const sourceB = await w.job(kind, 'B', { ...extra, sequenceId: b.id });
  const reference = kind === 'posts' ? 'postId' : 'positionId';
  const person = await w.hire('序列迟到员工', {
    departmentId: org.id,
    ...(post ? { postId: post.id } : {}),
    [reference]: sourceA.id,
    sequenceId: a.id,
    place: '原地点',
  });
  const transfer = await w.business(
    person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { [reference]: sourceB.id, sequenceId: b.id },
    },
    person.revision,
  );
  const sync = async () => {
    const response = await callAt(db, w)(
      'PATCH',
      `${kind}/${sourceB.id}`,
      {
        sequenceId: c.id,
        effectiveDate: '2026-10-05',
        syncSequenceToAssignments: true,
      },
      sourceB.revision,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await worker(db, w.tenant.id)).toMatchObject({ completed: 1, failed: 0 });
  };
  if (syncFirst) await sync();
  expect((await w.patchOrg(org, { name: '改名', effectiveDate: '2026-10-09', addEmployment: true })).status).toBe(200);
  if (!syncFirst) await sync();
  const adjustment = (await w.records(person.id, '2026-10-09')).find((r) => r.isCurrent)!;
  expect(adjustment.fields).toMatchObject({ [reference]: sourceB.id, sequenceId: c.id });
  const result = await runEmploymentActivations(
    db,
    cmd(),
    { tenantId: w.tenant.id },
    {
      clock: () => new Date('2026-10-10T01:00:00Z'),
    },
  );
  expect(result.runs[0]).toMatchObject({ failed: [], errors: [] });
  expect
    .soft((await w.records(person.id, '2026-10-09')).find((r) => r.isCurrent))
    .toMatchObject({ id: adjustment.id, fields: { [reference]: sourceA.id, sequenceId: a.id } });
  expect((await w.records(person.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: transfer.id,
    fields: { [reference]: sourceB.id, sequenceId: c.id },
  });
  const beforeRetry = await versions(db, w.tenant.id, person.id);
  await runEmploymentActivations(
    db,
    cmd(),
    { tenantId: w.tenant.id },
    { clock: () => new Date('2026-10-10T02:00:00Z') },
  );
  expect(await versions(db, w.tenant.id, person.id)).toEqual(beforeRetry);
});
