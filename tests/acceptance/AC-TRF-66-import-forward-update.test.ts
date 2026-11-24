/**
 * AC-TRF-66（F-036-S4）：HR 导入编辑当前任职的职位，传播进本人调动草稿后，
 * 员工改期、提交、同键重放三个入口都按同一个判定函数放行；撤掉账号绑定后同键重放被拒。
 * 设计：docs/08_设计/F-036_字段来源记录与迟到后重建_设计.md §7.1、§10.1。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, LATER, ok, selfWorld } from './AC-TRF-F036S4-support.js';

const database = useTestDb();

async function world(label: string) {
  const s = await selfWorld(database().db, label);
  const base = await s.catalog();
  // 同一职务下的另一个职位：导入校验要求职位与记录上的职务一致。
  const other = { position: await s.jobs.position(base.post) };
  const person = await s.employee('合成员工', {
    postId: base.post,
    sequenceId: base.sequence,
    levelId: base.level,
    positionId: base.position,
  });
  const draft = await s.draftOf(person);
  const { w } = s;
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}`),
  );
  const record = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${BASE}/records/${person.recordId}`),
  );
  // HR 用导入的编辑模式改员工当前任职的职位，向后更新写进本人草稿。
  await ok(
    await w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/import`, {
      ifMatch: employee.revision,
      body: {
        items: [
          {
            operation: 'edit',
            id: person.recordId,
            revision: record.revision,
            patch: { fields: { positionId: other.position } },
          },
        ],
      },
    }),
  );
  expect(await s.origin(draft.id, 'positionId')).toEqual({ value: other.position, kind: 'forward-update' });
  return { s, other, person, draft };
}

const unbind = (s: Awaited<ReturnType<typeof world>>['s'], userId: string) =>
  withTenant(database().db, s.w.tenant.id, (tx) =>
    tx.execute(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id = ${s.w.tenant.id} AND user_id = ${userId}::uuid`),
  );

describe('AC-TRF-66 导入编辑传播进草稿后，员工三个入口都放行', () => {
  it('入口一 PATCH：只改生效日是 200，职位仍是传播来的值，来源仍是 forward-update', async () => {
    const { s, other, person, draft } = await world('f036s4-66-patch');
    const before = await s.counts(draft.id);
    await ok(await s.patch(person, draft.id, { effectiveDate: LATER }));
    expect((await s.show(draft.id)).effectiveDate).toBe(LATER);
    expect((await s.show(draft.id)).fields).toMatchObject({ positionId: other.position });
    expect(await s.origin(draft.id, 'positionId')).toEqual({ value: other.position, kind: 'forward-update' });
    expect((await s.counts(draft.id)).manual).toBe(before.manual);
  });

  it('入口二 提交：200，职位与来源不变', async () => {
    const { s, other, person, draft } = await world('f036s4-66-submit');
    await ok(await s.submit(person, draft.id));
    expect((await s.show(draft.id)).fields).toMatchObject({ positionId: other.position });
    expect(await s.origin(draft.id, 'positionId')).toEqual({ value: other.position, kind: 'forward-update' });
  });

  it('入口三 同键重放：PATCH、提交各重放一次，返回首次结果，不追加载荷版本与来源行', async () => {
    const { s, other, person, draft } = await world('f036s4-66-replay');
    const patch = { key: 'k-f036s4-66-patch', revision: (await s.show(draft.id)).revision };
    const first = await ok(await s.patch(person, draft.id, { effectiveDate: LATER }, patch));
    const afterPatch = await s.counts(draft.id);
    const replay = await ok(await s.patch(person, draft.id, { effectiveDate: LATER }, patch));
    expect(await replay.json()).toEqual(await first.json());
    expect(await s.counts(draft.id)).toEqual(afterPatch);

    const submit = { key: 'k-f036s4-66-submit', revision: (await s.show(draft.id)).revision };
    const submitted = await ok(await s.submit(person, draft.id, submit));
    const afterSubmit = await s.counts(draft.id);
    const again = await ok(await s.submit(person, draft.id, submit));
    expect(await again.json()).toEqual(await submitted.json());
    expect(await s.counts(draft.id)).toEqual(afterSubmit);
    expect(await s.origin(draft.id, 'positionId')).toEqual({ value: other.position, kind: 'forward-update' });
  });

  it('撤掉账号绑定后，提交的同键重放被拒（403），不因命令台账缓存放行；单据不变', async () => {
    const { s, person, draft } = await world('f036s4-66-unbind-submit');
    const options = { key: 'k-f036s4-66-unbind-submit', revision: (await s.show(draft.id)).revision };
    await ok(await s.submit(person, draft.id, options));
    const before = { counts: await s.counts(draft.id), shown: await s.show(draft.id) };
    await unbind(s, person.userId);
    const response = await s.submit(person, draft.id, options);
    expect(response.status, await response.clone().text()).toBe(403);
    expect({ counts: await s.counts(draft.id), shown: await s.show(draft.id) }).toEqual(before);
  });

  it('撤掉账号绑定后，PATCH 的同键重放被拒（403），不因命令台账缓存放行；单据不变', async () => {
    const { s, person, draft } = await world('f036s4-66-unbind-patch');
    const options = { key: 'k-f036s4-66-unbind-patch', revision: (await s.show(draft.id)).revision };
    await ok(await s.patch(person, draft.id, { effectiveDate: LATER }, options));
    const before = { counts: await s.counts(draft.id), shown: await s.show(draft.id) };
    await unbind(s, person.userId);
    const response = await s.patch(person, draft.id, { effectiveDate: LATER }, options);
    expect(response.status, await response.clone().text()).toBe(403);
    expect({ counts: await s.counts(draft.id), shown: await s.show(draft.id) }).toEqual(before);
  });
});

describe('AC-TRF-66 已生效的任职记录：导入编辑按生效记录契约校验，不套员工草稿的 J2', () => {
  it('员工调动生效后 HR 同值确认序列（hr-record）；HR 导入编辑只改工作地 → 200；员工旧命令同键重放仍 403', async () => {
    const s = await selfWorld(database().db, 'f036s4-66-effective-import');
    const base = await s.catalog();
    const person = await s.employee('合成员工', {
      postId: base.post,
      sequenceId: base.sequence,
      levelId: base.level,
      positionId: base.position,
    });
    const draft = await s.draftOf(person, {}, '2026-09-25');
    const old = { key: 'k-f036s4-66-effective', revision: draft.revision };
    await ok(await s.patch(person, draft.id, { effectiveDate: '2026-09-26' }, old));
    await ok(await s.submit(person, draft.id));
    const { w } = s;
    const instance = await w.instanceOf(draft.id, person.userId);
    await ok(await w.taskAction(s.reviewer.userId, w.pending(instance)[0]!.id, 'approve', instance.revision));
    expect((await s.show(draft.id)).status).toBe('effective');

    // HR 经 /records/:id 同值确认序列：来源记为 hr-record（不属于员工草稿可信来源）。
    const recordId = await s.recordOfBusiness(draft.id);
    await ok(await s.hrEditCurrent(person, { sequenceId: base.sequence }, undefined, recordId));
    expect(await s.originKinds(recordId, 'preset:sequenceId')).toContain('hr-record');

    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}`),
    );
    const record = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${BASE}/records/${recordId}`));
    const imported = await w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/import`, {
      ifMatch: employee.revision,
      body: {
        items: [
          { operation: 'edit', id: recordId, revision: record.revision, patch: { fields: { place: '新工作地' } } },
        ],
      },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);

    // 403 前后载荷版本与来源表行数（草稿与生效记录两个键）、单据内容完全一致：被拒的重放没有写任何东西。
    const state = async () => ({
      draft: await s.counts(draft.id),
      record: await s.counts(recordId),
      shown: await s.show(draft.id),
    });
    const before = await state();
    const replay = await s.patch(person, draft.id, { effectiveDate: '2026-09-26' }, old);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await state()).toEqual(before);
  });
});
