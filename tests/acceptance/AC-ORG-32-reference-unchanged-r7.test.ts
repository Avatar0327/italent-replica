/**
 * astra R6-P2-02：引用未变时不得重新派生。职务序列被清空后任职保留原序列（DEC-208）；F-006 明确选择
 * “不调整直线经理”的后续上级变更不改任职；仅改地点的迟到调动重建都不能借机重算这些派生值。
 */
import { runEmploymentActivations } from '@italent/api';
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { callAt, worker } from './AC-JOB-sequence-support.js';
import { orgPeopleWorld, type OrgPeopleWorld } from './AC-ORG-people-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const LATE = '2026-10-10T01:00:00Z';

async function lateTransfer(w: OrgPeopleWorld, employeeId: string) {
  return w.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { place: '迟到调动地点' } },
    (await w.getEmployee(employeeId)).revision,
  );
}

async function rename(w: OrgPeopleWorld, org: { id: string; revision: number }, employeeId: string) {
  const before = new Set((await w.records(employeeId, '2026-10-09')).map((r) => r.id));
  const response = await w.patchOrg(org, { name: '改名部门', effectiveDate: '2026-10-09', addEmployment: true });
  expect(response.status, await response.clone().text()).toBe(200);
  const added = (await w.records(employeeId, '2026-10-09')).filter((r) => !before.has(r.id));
  expect(added).toHaveLength(1);
  return added[0]!.id;
}

async function runLate(db: Db, w: OrgPeopleWorld) {
  const result = await runEmploymentActivations(db, cmd(), { tenantId: w.tenant.id }, { clock: () => new Date(LATE) });
  expect(result.runs[0]).toMatchObject({ failed: [], errors: [] });
}

it.each((['create', 'edit'] as const).flatMap((derivedBy) => [false, true].map((chain) => ({ derivedBy, chain }))))(
  'AC-ORG-32 R6-P2-02 序列清空后迟到重建保留 SB / 带出于=$derivedBy / 后接F-007=$chain',
  async ({ derivedBy, chain }) => {
    const { db } = database();
    const w = await orgPeopleWorld(db, `r7seq${derivedBy}${chain}`);
    const org = await w.org('序列部门');
    const sequenceA = await w.job('sequences', 'S_A');
    const sequenceB = await w.job('sequences', 'S_B');
    const postA = await w.job('posts', '职务 A', { sequenceId: sequenceA.id });
    const postB = await w.job('posts', '职务 B', { sequenceId: sequenceB.id });
    const person = await w.hire('员工', {
      departmentId: org.id,
      postId: postA.id,
      sequenceId: sequenceA.id,
      place: '原地点',
    });
    await lateTransfer(w, person.id);
    const adjustment = await w.business(
      person.id,
      {
        kind: 'org_adjustment',
        mode: 'direct',
        effectiveDate: '2026-10-09',
        fields: derivedBy === 'create' ? { postId: postB.id } : { remarks: '先建后改职务' },
      },
      (await w.getEmployee(person.id)).revision,
    );
    if (derivedBy === 'edit') {
      const edited = await w.request('PATCH', `/records/${adjustment.id}`, {
        ifMatch: adjustment.revision,
        body: { fields: { postId: postB.id } },
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
    }
    const ids = [adjustment.id, ...(chain ? [await rename(w, org, person.id)] : [])];
    for (const id of ids)
      expect((await w.record(id, '2026-10-09')).fields).toMatchObject({ postId: postB.id, sequenceId: sequenceB.id });
    // DEC-208：清空职务序列不同步任职，引用它的记录保留 S_B。
    const cleared = await callAt(db, w)(
      'PATCH',
      `posts/${postB.id}`,
      { sequenceId: null, effectiveDate: '2026-10-09' },
      postB.revision,
    );
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await worker(db, w.tenant.id)).toMatchObject({ failed: 0 });
    for (const id of ids) expect((await w.record(id, '2026-10-09')).fields.sequenceId).toBe(sequenceB.id);
    await runLate(db, w);
    for (const id of ids)
      expect.soft((await w.record(id, '2026-10-09')).fields, `组织调整 ${id}`).toMatchObject({
        postId: postB.id,
        sequenceId: sequenceB.id,
        place: '原地点',
      });
  },
);

it('AC-ORG-32 R6-P2-02 F-006 明确不调整经理后，职位引用未变的迟到重建不重算经理', async () => {
  const { db } = database();
  const w = await orgPeopleWorld(db, 'r7managerKeep');
  const org = await w.org('经理部门');
  const post = await w.job('posts', '职务');
  const parentB = await w.job('positions', '上级 B', { orgId: org.id, postId: post.id });
  const parentC = await w.job('positions', '上级 C', { orgId: org.id, postId: post.id });
  const position = await w.job('positions', '员工职位', { orgId: org.id, postId: post.id });
  const managerB = await w.hire('经理 B', { departmentId: org.id, positionId: parentB.id });
  const managerC = await w.hire('经理 C', { departmentId: org.id, positionId: parentC.id });
  const person = await w.hire('员工', { departmentId: org.id, positionId: position.id, place: '原地点' });
  await lateTransfer(w, person.id);
  const change = (parentId: string, revision: number, adjust: boolean) =>
    w.call('PATCH', `job/positions/${position.id}`, {
      ifMatch: revision,
      body: { parents: { admin: { parentId } }, effectiveDate: '2026-10-09', adjustEmployeeDirectManager: adjust },
    });
  const first = await change(parentB.id, position.revision, true);
  expect(first.status, await first.clone().text()).toBe(200);
  const adjustment = (await w.records(person.id, '2026-10-09')).find((r) => r.kind === 'org_adjustment')!;
  expect(adjustment.fields.directManagerId).toBe(managerB.id);
  const second = await change(parentC.id, ((await first.json()) as { revision: number }).revision, false);
  expect(second.status, await second.clone().text()).toBe(200);
  expect((await w.records(person.id, '2026-10-09')).filter((r) => r.kind === 'org_adjustment')).toHaveLength(1);
  expect((await w.record(adjustment.id, '2026-10-09')).fields.directManagerId).toBe(managerB.id);
  await runLate(db, w);
  expect((await w.record(adjustment.id, '2026-10-09')).fields).toMatchObject({
    positionId: position.id,
    directManagerId: managerB.id,
    place: '原地点',
  });
  expect(managerC.id).not.toBe(managerB.id);
});
