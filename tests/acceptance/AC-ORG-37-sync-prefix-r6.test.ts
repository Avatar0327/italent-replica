/** F-021 × F-007：自动同步依赖当时的引用，后续来源不能倒灌引用使旧同步提前生效。 */
import { runEmploymentActivations } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { orgPeopleWorld } from './AC-ORG-people-support.js';
import { callAt, versions, worker } from './AC-JOB-sequence-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();

it('AC-ORG-37 同步不能借用后来恢复的引用阻断人工来源传播', async () => {
  const db = database().db;
  const w = await orgPeopleWorld(db, 'r6syncprefix');
  const org = await w.org('同步前缀部门');
  const a = await w.job('sequences', 'S_A');
  const b = await w.job('sequences', 'S_B');
  const c = await w.job('sequences', '自动 S_C');
  const x = await w.job('sequences', '人工来源 S_X');
  const y = await w.job('sequences', '独立 S_Y');
  const postA = await w.job('posts', '职务 A', { sequenceId: a.id });
  const postB = await w.job('posts', '职务 B', { sequenceId: b.id });
  const person = await w.hire('员工', { departmentId: org.id, postId: postA.id, sequenceId: a.id });
  const transfer = await w.business(
    person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { postId: postB.id, sequenceId: b.id },
    },
    person.revision,
  );
  const create = async (date: string, fields: Record<string, string>) =>
    w.business(
      person.id,
      { kind: 'org_adjustment', mode: 'direct', effectiveDate: date, fields },
      (await w.getEmployee(person.id)).revision,
    );
  const target = await create('2026-10-09', { remarks: '隐式目标' });
  const middle = await create('2026-10-08', { sequenceId: y.id, remarks: '中间记录' });
  const source = await create('2026-10-07', { remarks: '人工来源' });
  const synchronized = await callAt(db, w)(
    'PATCH',
    `posts/${postB.id}`,
    { sequenceId: c.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true },
    postB.revision,
  );
  expect(synchronized.status, await synchronized.clone().text()).toBe(200);
  expect(await worker(db, w.tenant.id)).toMatchObject({ completed: 1, failed: 0 });
  for (const id of [source.id, middle.id, target.id])
    expect((await w.record(id, '2026-10-09')).fields).toMatchObject({ postId: postB.id, sequenceId: c.id });
  const edit = async (id: string, fields: Record<string, string>) => {
    const loaded = await w.request('GET', `/businesses/${id}`);
    expect(loaded.status, await loaded.clone().text()).toBe(200);
    const { revision } = (await loaded.json()) as { revision: number };
    const edited = await w.request('PATCH', `/records/${id}`, { ifMatch: revision, body: { fields } });
    expect(edited.status, await edited.clone().text()).toBe(200);
  };
  w.setNow('2026-10-05T01:00:00Z');
  // postB 是同值人工输入；序列 X 的真实传播事件在旧同步之后。
  await edit(source.id, { postId: postB.id, sequenceId: x.id });
  expect((await w.record(target.id, '2026-10-09')).fields).toMatchObject({ postId: postB.id, sequenceId: x.id });
  const run = (date: string) =>
    runEmploymentActivations(db, cmd(), { tenantId: w.tenant.id }, { clock: () => new Date(`${date}T01:00:00Z`) });
  expect((await run('2026-10-05')).runs[0]).toMatchObject({ failed: [], errors: [] });
  w.setNow('2026-10-11T01:00:00Z');
  // 历史更正只改变 middle 自身；目标仍为 B/X。
  await edit(middle.id, { postId: postA.id });
  expect((await w.record(middle.id, '2026-10-08')).fields).toMatchObject({ postId: postA.id, sequenceId: a.id });
  expect((await w.record(target.id, '2026-10-09')).fields).toMatchObject({ postId: postB.id, sequenceId: x.id });
  expect((await run('2026-10-12')).runs[0]).toMatchObject({ failed: [], errors: [] });
  expect((await w.record(source.id, '2026-10-07')).fields).toMatchObject({ postId: postB.id, sequenceId: x.id });
  // 旧同步不能借 middle 恢复的引用 A 提前写入 C；人工来源的 B/X 保持。
  expect((await w.record(target.id, '2026-10-09')).fields).toMatchObject({ postId: postB.id, sequenceId: x.id });
  expect((await w.record(transfer.id, '2026-10-12')).effectiveDate).toBe('2026-10-05');
  const beforeRetry = await versions(db, w.tenant.id, person.id);
  expect((await run('2026-10-12')).runs[0]).toMatchObject({ failed: [], errors: [] });
  expect(await versions(db, w.tenant.id, person.id)).toEqual(beforeRetry);
});
