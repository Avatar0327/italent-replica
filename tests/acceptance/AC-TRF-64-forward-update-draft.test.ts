/**
 * AC-TRF-64（F-036-S4）：向后更新、序列同步这类系统写入，不算员工输入。
 * 设计：docs/08_设计/F-036_字段来源记录与迟到后重建_设计.md §5.2、§7.1、§10.1。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { allowAll } from './support/tenant-api.js';
import { runSequenceSyncJobs } from '../../apps/api/src/modules/job/sequence-worker.js';
import { LATER, ok, selfWorld } from './AC-TRF-F036S4-support.js';

const database = useTestDb();

describe('AC-TRF-64 系统写入不算员工输入', () => {
  it('主路径：HR 改当前任职的职务，向后更新写进本人草稿；员工只改生效日仍是 200', async () => {
    const s = await selfWorld(database().db, 'f036s4-64-main');
    const old = await s.catalog();
    const next = await s.catalog();
    const person = await s.employee('合成员工', {
      postId: old.post,
      sequenceId: old.sequence,
      levelId: old.level,
      positionId: old.position,
    });
    const draft = await s.draftOf(person);
    expect(await s.origin(draft.id, 'postId')).toEqual({ value: old.post, kind: 'inherit' });

    await ok(await s.hrEditCurrent(person, { postId: next.post, positionId: next.position }));
    // 向后更新把职务与职位带进了草稿：来源是系统写入，不是员工输入。
    expect(await s.origin(draft.id, 'postId')).toEqual({ value: next.post, kind: 'forward-update' });
    expect((await s.show(draft.id)).fields).toMatchObject({ postId: next.post, positionId: next.position });

    const before = await s.counts(draft.id);
    const response = await s.patch(person, draft.id, { effectiveDate: LATER });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await s.show(draft.id)).effectiveDate).toBe(LATER);
    // 职务仍是向后更新写入的值，来源不变；这次修改没有给职务追加来源行。
    expect(await s.origin(draft.id, 'postId')).toEqual({ value: next.post, kind: 'forward-update' });
    const after = await s.counts(draft.id);
    expect(after.versions).toBe(before.versions + 1);
  });

  it('备选路径：审批中被序列同步写入序列，撤回后员工只改生效日仍是 200', async () => {
    const { db } = database();
    const s = await selfWorld(db, 'f036s4-64-sync');
    const old = await s.catalog();
    const nextSequence = await s.jobs.sequence();
    const person = await s.employee('合成员工', {
      postId: old.post,
      sequenceId: old.sequence,
      levelId: old.level,
      positionId: old.position,
    });
    const draft = await s.draftOf(person);
    await ok(await s.submit(person, draft.id));
    const { w } = s;
    const post = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/job/posts/${old.post}`),
    );
    await ok(
      await w.request(w.hr.id, 'PATCH', `/api/tenant/job/posts/${old.post}`, {
        ifMatch: post.revision,
        body: { sequenceId: nextSequence, effectiveDate: '2026-10-01' },
      }),
    );
    await runSequenceSyncJobs(db, w.tenant.id, { clock: w.clock, authorize: allowAll });
    expect(await s.origin(draft.id, 'sequenceId')).toEqual({ value: nextSequence, kind: 'sequence-sync' });

    const instance = await w.instanceOf(draft.id, person.userId);
    await ok(await w.instanceAction(person.userId, instance.id, 'withdraw', instance.revision));
    expect((await s.show(draft.id)).status).toBe('draft');
    const response = await s.patch(person, draft.id, { effectiveDate: LATER });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await s.origin(draft.id, 'sequenceId')).toEqual({ value: nextSequence, kind: 'sequence-sync' });
  });
});
