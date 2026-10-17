/**
 * F-181a：调动暂存服务端按人一份（DEC-511 / DEC-596；#350 第 1 轮审查遗留；#403 第 1 轮返工）。
 * 同一经办人对同一员工只保留一份“他人调动申请”暂存单：再暂存覆盖、提交释放、清除删单，并提供元数据读口。
 * 读口：GET /transfers/employees/:id/draft；清除：DELETE /transfers/employees/:id/draft/:businessId
 * （If-Match = 读口给的暂存单 revision，路径带单号，被新暂存替换后的旧页面清除得 409）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { D, saved, slotWorld, waitForLockWaiters, type SlotWorld } from './AC-TRF-F181a-support.js';

const database = useTestDb();
const world = (label: string) => slotWorld(database().db, label);
const errorOf = async (response: Response) =>
  (await response.json()) as { error: { code: string; details?: { reason?: string } } };

describe('AC-TRF-F181a 调动暂存服务端按人一份', () => {
  it('①暂存后读口返回暂存单元数据（异动类型、原因、编制、表单、生效日）', async () => {
    const s = await world('f181a-meta');
    expect(await s.draft()).toBeNull();
    const first = await saved(await s.save());
    expect(await s.draft()).toMatchObject({
      id: first.id,
      employeeId: s.employeeId,
      revision: first.revision,
      transferTypeCode: 'cross_department',
      reasonCode: null,
      withEstablishment: false,
      effectiveDate: D,
    });
  });

  it('②同一人再暂存覆盖：读口指向新单，旧暂存单被删除，草稿恰好一份', async () => {
    const s = await world('f181a-overwrite');
    const first = await saved(await s.save());
    const second = await saved(await s.save({ effectiveDate: '2026-10-12' }));
    expect(second.id).not.toBe(first.id);
    expect(await s.draft()).toMatchObject({ id: second.id, effectiveDate: '2026-10-12' });
    expect(await s.businessState(first.id)).toBe('deleted');
    expect((await s.liveDrafts()).map((row) => row.id)).toEqual([second.id]);
  });

  it('③不同经办人各留一份，互相看不到也覆盖不了', async () => {
    const s = await world('f181a-owners');
    const colleague = await s.colleague();
    const mine = await saved(await s.save());
    const theirs = await saved(await s.save({ effectiveDate: '2026-10-15' }, colleague.id));
    expect(await s.draft()).toMatchObject({ id: mine.id });
    expect(await s.draft(colleague.id)).toMatchObject({ id: theirs.id });
    expect(await s.businessState(mine.id)).toBe('draft');
    // 同事清除只清自己的那份，我的暂存单不受影响
    expect((await s.clear(theirs.id, theirs.revision, randomUUID(), colleague.id)).status).toBe(200);
    expect(await s.draft(colleague.id)).toBeNull();
    expect(await s.draft()).toMatchObject({ id: mine.id });
    expect(await s.businessState(mine.id)).toBe('draft');
  });

  it('④提交（新建即提交）释放暂存：旧暂存单删除，读口为空', async () => {
    const s = await world('f181a-submit');
    const first = await saved(await s.save());
    await saved(await s.save({ submit: true }));
    expect(await s.draft()).toBeNull();
    expect(await s.businessState(first.id)).toBe('deleted');
    expect(await s.slots()).toEqual([]);
  });

  it('⑤撤回回到草稿的申请不是暂存单：读口为空，再暂存也不会删它', async () => {
    const s = await world('f181a-withdrawn');
    const submitted = await saved(await s.save({ submit: true }));
    const withdraw = await s.request('POST', `/businesses/${submitted.id}/withdraw`, { ifMatch: submitted.revision });
    expect(withdraw.status, await withdraw.clone().text()).toBe(200);
    expect(await s.businessState(submitted.id)).toBe('draft');
    expect(await s.draft()).toBeNull();
    const stash = await saved(await s.save({ effectiveDate: '2026-10-20' }));
    expect(await s.businessState(submitted.id)).toBe('draft');
    expect(await s.draft()).toMatchObject({ id: stash.id });
  });

  it('⑥清除：删除暂存单并清空读口；同命令 ID 重放得到原结果，过期 revision 409，无暂存 404', async () => {
    const s = await world('f181a-clear');
    const first = await saved(await s.save());
    expect((await s.clear(first.id, first.revision + 1)).status).toBe(409);
    expect(await s.draft()).toMatchObject({ id: first.id });
    const key = randomUUID();
    const cleared = await s.clear(first.id, first.revision, key);
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await cleared.json()).toMatchObject({ id: first.id, status: 'deleted' });
    expect(await s.draft()).toBeNull();
    expect(await s.businessState(first.id)).toBe('deleted');
    expect(await s.slots()).toEqual([]);
    const replay = await s.clear(first.id, first.revision, key);
    expect(replay.status).toBe(200);
    expect((await s.clear(first.id, first.revision)).status).toBe(404);
    // 清除后可以再暂存
    const again = await saved(await s.save());
    expect(await s.draft()).toMatchObject({ id: again.id });
  });

  it('⑦只能清除自己的暂存：他人没有暂存时 404，不泄露别人的暂存单', async () => {
    const s = await world('f181a-foreign');
    const colleague = await s.colleague();
    const mine = await saved(await s.save());
    expect((await s.clear(mine.id, mine.revision, randomUUID(), colleague.id)).status).toBe(404);
    expect(await s.draft(colleague.id)).toBeNull();
    expect(await s.businessState(mine.id)).toBe('draft');
  });

  // #403 第 1 轮 P2-1：新单 revision 仍是 1，旧页面带旧 revision 也能对上——必须再绑定单号
  it('⑧覆盖后用旧页面清除：409 DRAFT_REPLACED，新暂存单与槽位不变', async () => {
    const s = await world('f181a-stale-page');
    const pageA = await saved(await s.save());
    const pageB = await saved(await s.save({ effectiveDate: '2026-10-12' }));
    expect(pageB.revision).toBe(pageA.revision);
    const stale = await s.clear(pageA.id, pageA.revision);
    expect(stale.status, await stale.clone().text()).toBe(409);
    expect((await errorOf(stale)).error.details?.reason).toBe('DRAFT_REPLACED');
    expect(await s.businessState(pageB.id)).toBe('draft');
    expect(await s.draft()).toMatchObject({ id: pageB.id });
    expect(await s.slots()).toMatchObject([{ businessId: pageB.id }]);
    // 新页面用新单号清除才成功
    expect((await s.clear(pageB.id, pageB.revision)).status).toBe(200);
  });

  // #403 第 1 轮 P2-3：暂存 → 通用提交 → 撤回，暂存位不得重新出现
  it('⑨暂存后经 POST /businesses/:id/submit 提交：槽位同事务移除，撤回后读口仍为空，再暂存不删撤回单', async () => {
    const s = await world('f181a-generic-submit');
    const stash = await saved(await s.save());
    const submit = await s.request('POST', `/businesses/${stash.id}/submit`, {
      ifMatch: stash.revision,
      body: {},
    });
    expect(submit.status, await submit.clone().text()).toBe(200);
    const submitted = (await submit.json()) as { revision: number };
    expect(await s.draft()).toBeNull();
    expect(await s.slots()).toEqual([]);
    const withdraw = await s.request('POST', `/businesses/${stash.id}/withdraw`, { ifMatch: submitted.revision });
    expect(withdraw.status, await withdraw.clone().text()).toBe(200);
    expect(await s.businessState(stash.id)).toBe('draft');
    expect(await s.draft()).toBeNull();
    const next = await saved(await s.save({ effectiveDate: '2026-10-21' }));
    expect(await s.businessState(stash.id)).toBe('draft');
    expect(await s.draft()).toMatchObject({ id: next.id });
  });

  it('⑩通用删除（DELETE /businesses/:id）暂存单后槽位同事务移除', async () => {
    const s = await world('f181a-generic-delete');
    const stash = await saved(await s.save());
    const removed = await s.request('DELETE', `/businesses/${stash.id}`, { ifMatch: stash.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await s.slots()).toEqual([]);
    expect(await s.draft()).toBeNull();
  });
});

type Outcome = { stash: Response; clear: Response };

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TRF-F181a 真实 PG 并发（员工锁屏障 + 确定交错）', () => {
  /** 在员工行锁上设屏障，让发出的请求按给定顺序依次卡到锁上，再放行，观察确定的交错结果。 */
  async function interleave(s: SlotWorld, requests: ReadonlyArray<() => Promise<Response>>) {
    const pending: Promise<Response>[] = [];
    await withTenant(s.w.db, s.tenantId, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${s.tenantId} AND id=${s.employeeId}::uuid FOR UPDATE`);
      for (const [index, send] of requests.entries()) {
        pending.push(send());
        await waitForLockWaiters(s.w.db, index + 1);
      }
    });
    return Promise.all(pending);
  }

  it('⑪两次暂存同时卡在员工锁上：先到者 201，后到者 409（同一 If-Match），最终恰好一份且读口 = 胜者', async () => {
    const s = await world('f181a-race');
    const revision = await (async () => (await s.w.session.getEmployee(s.employeeId)).revision)();
    const send = (effectiveDate: string) => () =>
      s.request('POST', `/transfers/employees/${s.employeeId}`, {
        ifMatch: revision,
        idempotencyKey: randomUUID(),
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          submit: false,
          effectiveDate,
          fields: { departmentId: s.w.to.id },
        },
      });
    const [first, second] = await interleave(s, [send('2026-10-11'), send('2026-10-12')]);
    expect([first!.status, second!.status]).toEqual([201, 409]);
    const won = (await first!.json()) as { id: string };
    expect((await s.liveDrafts()).map((row) => row.id)).toEqual([won.id]);
    expect(await s.draft()).toMatchObject({ id: won.id, effectiveDate: '2026-10-11' });
    expect(await s.slots()).toMatchObject([{ businessId: won.id }]);
    // 败者按新版本重提即覆盖胜者：仍恰好一份
    const retried = await saved(await s.save({ effectiveDate: '2026-10-14' }));
    expect((await s.liveDrafts()).map((row) => row.id)).toEqual([retried.id]);
    expect(await s.businessState(won.id)).toBe('deleted');
  });

  async function stashAndClear(label: string, order: 'stash-first' | 'clear-first') {
    const s = await world(label);
    const old = await saved(await s.save());
    const revision = (await s.w.session.getEmployee(s.employeeId)).revision;
    const stash = () =>
      s.request('POST', `/transfers/employees/${s.employeeId}`, {
        ifMatch: revision,
        idempotencyKey: randomUUID(),
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          submit: false,
          effectiveDate: '2026-10-13',
          fields: { departmentId: s.w.to.id },
        },
      });
    const clear = () => s.clear(old.id, old.revision);
    const sends = order === 'stash-first' ? [stash, clear] : [clear, stash];
    const done = await interleave(s, sends);
    const outcome: Outcome =
      order === 'stash-first' ? { stash: done[0]!, clear: done[1]! } : { clear: done[0]!, stash: done[1]! };
    return { s, old, outcome };
  }

  it('⑫先暂存后清除（旧单号）：暂存 201 替换旧单，清除 409 DRAFT_REPLACED，新暂存单保留', async () => {
    const { s, old, outcome } = await stashAndClear('f181a-race-stash-first', 'stash-first');
    expect(outcome.stash.status).toBe(201);
    const fresh = (await outcome.stash.json()) as { id: string };
    expect(outcome.clear.status, await outcome.clear.clone().text()).toBe(409);
    expect((await errorOf(outcome.clear)).error.details?.reason).toBe('DRAFT_REPLACED');
    expect(await s.businessState(old.id)).toBe('deleted');
    expect((await s.liveDrafts()).map((row) => row.id)).toEqual([fresh.id]);
    expect(await s.draft()).toMatchObject({ id: fresh.id });
  });

  it('⑬先清除后暂存（同一入口 If-Match）：清除 200，暂存因员工版本已被推进 409，最终没有暂存单', async () => {
    const { s, old, outcome } = await stashAndClear('f181a-race-clear-first', 'clear-first');
    expect(outcome.clear.status, await outcome.clear.clone().text()).toBe(200);
    expect(outcome.stash.status, await outcome.stash.clone().text()).toBe(409);
    expect(await s.businessState(old.id)).toBe('deleted');
    expect(await s.liveDrafts()).toEqual([]);
    expect(await s.draft()).toBeNull();
    expect(await s.slots()).toEqual([]);
  });
});
