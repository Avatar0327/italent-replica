/**
 * F-053 第 2 轮（审查 P2-1）：活动启用对用到的套卷按 id 升序取行锁；“新增评价对象 / 替换套卷”传入多个套卷时，
 * 若按请求数组顺序插入关联（外键 KEY SHARE 锁），与启用形成反向等待 → PG 死锁，一个合法命令被回滚。
 * 确定性交错：门事务先持有 Q大，请求 B（逆序传入 [Q大, Q小]）先排队，再让启用 A 排队，释放门后：
 * 修复前 B 拿到 Q大 要 Q小、A 拿到 Q小 要 Q大 → 死锁；修复后双方都先按 id 升序取锁，互相只是排队。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type World360, world360 } from './AC-360-support.js';
import { enable, holdQuestionnaire, waitLockWaiters } from './AC-360-F053-support.js';

const testDb = useTestDb();
afterEach(() => vi.restoreAllMocks());

/** 两个“已使用”的共享套卷（Q小 < Q大），活动 A 用着它们、已停用，等待重新启用。 */
async function sharedPair(w: World360) {
  const first = await w.enableQuestionnaire(await w.keyBehavior());
  const second = await w.enableQuestionnaire(await w.keyBehavior());
  const [small, big] = [first.id, second.id].sort() as [string, string];
  const a = await w.activity();
  await w.object(a.id, (await w.person('活动A对象')).id, [small, big]);
  await w.transition(a.id, 'enable');
  await w.transition(a.id, 'disable');
  const third = await w.enableQuestionnaire(await w.keyBehavior());
  const b = await w.activity();
  const objectB = await w.object(b.id, (await w.person('活动B对象')).id, [third.id]);
  return { small, big, a, b, objectB };
}

async function interleave(
  w: World360,
  fixture: Awaited<ReturnType<typeof sharedPair>>,
  other: () => Promise<Response>,
) {
  const gate = holdQuestionnaire(w, fixture.big);
  let others: Promise<Response> | undefined;
  let enabling: Promise<Response> | undefined;
  try {
    await gate.reached.promise;
    others = other(); // B 先排队：修复前停在 Q大 的外键锁上，修复后先拿 Q小 再等 Q大
    await waitLockWaiters(w.db, 1);
    enabling = enable(w, fixture.a.id); // A 随后：修复前拿 Q小 等 Q大，修复后等 Q小
    await waitLockWaiters(w.db, 2);
    gate.release.resolve();
    const [started, done] = await Promise.all([enabling, others]);
    return { started, done };
  } finally {
    gate.release.resolve();
    await Promise.allSettled([gate.promise, ...(others ? [others] : []), ...(enabling ? [enabling] : [])]);
  }
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-360-09 / F-053（DEC-319③）真实 PG：启用 × 多套卷取锁顺序',
  () => {
    it('新增评价对象传入逆序 [Q大, Q小] 与活动启用交错：都成功，没有死锁牺牲者', async () => {
      const w = await world360(testDb().db, 'f053-lock-add');
      const f = await sharedPair(w);
      const person = (await w.person('新增对象')).id;
      const { started, done } = await interleave(w, f, () =>
        w.request('POST', `/activities/${f.b.id}/objects`, {
          ifMatch: 0,
          body: { personId: person, questionnaireIds: [f.big, f.small] },
        }),
      );
      expect(started.status, '启用被当成死锁牺牲者回滚：' + (await started.clone().text())).toBe(200);
      expect(done.status, await done.clone().text()).toBe(201);
      expect((await w.getActivity(f.a.id)).status).toBe('enabled');
    });

    it('替换评价对象的套卷为逆序 [Q大, Q小] 与活动启用交错：都成功，没有死锁牺牲者', async () => {
      const w = await world360(testDb().db, 'f053-lock-replace');
      const f = await sharedPair(w);
      const { started, done } = await interleave(w, f, () =>
        w.request('PUT', `/activities/${f.b.id}/objects/${f.objectB.id}/questionnaires`, {
          ifMatch: f.objectB.revision,
          body: { questionnaireIds: [f.big, f.small] },
        }),
      );
      expect(started.status, '启用被当成死锁牺牲者回滚：' + (await started.clone().text())).toBe(200);
      expect(done.status, await done.clone().text()).toBe(200);
      expect((await w.getActivity(f.a.id)).status).toBe('enabled');
    });
  },
);
