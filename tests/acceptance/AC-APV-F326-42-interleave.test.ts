/** AC-42：暂停点只由 Vitest 包装已有函数注入，产品没有钩子状态或默认路径开销。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as Variables from '../../apps/api/src/modules/approval/variables.js';
import type * as AutoVariables from '../../apps/api/src/modules/approval/auto-variables.js';
import {
  actionsOf,
  audits,
  autoAt,
  autoRows,
  create,
  draftOk,
  editVariable,
  readProcess,
  s4World,
  saveDraft,
  specified,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { idleInTransaction, lockWaiters, settledOrBlocked, withRelease } from './support/pg-interleave.js';

// 两个可控挂点：流程头已锁、变量已插入 / 更新。放行前查询 PG 等待锁，不以 sleep 推断交错。
const hook = vi.hoisted(() => ({
  step: '',
  id: '',
  reached: Promise.resolve(),
  release: (): void => undefined,
  pause: async (): Promise<void> => undefined,
}));
vi.mock('../../apps/api/src/modules/approval/variables.js', async (original) => {
  const actual = await original<typeof Variables>();
  return {
    ...actual,
    auditVariable: async (...args: Parameters<typeof actual.auditVariable>) => {
      await actual.auditVariable(...args);
      if (hook.step === args[2] && args[4]?.originProcessId === hook.id) await hook.pause();
    },
  };
});
vi.mock('../../apps/api/src/modules/approval/auto-variables.js', async (original) => {
  const actual = await original<typeof AutoVariables>();
  return {
    ...actual,
    lockSaveBatch: async (...args: Parameters<typeof actual.lockSaveBatch>) => {
      if (hook.step === 'head' && args[2].processId === hook.id) await hook.pause();
      return actual.lockSaveBatch(...args);
    },
  };
});
const database = useTestDb();
function arm(step: string, id: string) {
  let reached!: () => void;
  hook.step = step;
  hook.id = id;
  hook.reached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    hook.release = resolve;
  });
  hook.pause = async () => {
    hook.step = '';
    reached();
    await gate;
  };
}
const node = (id: string) => [{ key: 'n1', name: '合成节点', approver: specified(id) }];
async function clean(db: Parameters<typeof lockWaiters>[0]) {
  expect(await lockWaiters(db)).toBe(0);
  expect(await idleInTransaction(db)).toBe(0);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-APV-F326-42 真 PG 强制交错（PGlite 跳过）', () => {
  it('① 两个流程编码前 51 位与时钟相同，插入阻塞后 DO NOTHING +1ms，两笔都提交', async () => {
    const w = await s4World(database().db, 's7d-code-lock');
    const stem = 'C'.repeat(51);
    // 先建没有自动变量的草稿，让测试能用流程 ID 精确指定暂停事务。
    const input = [{ key: 'n1', approver: { type: 'object_field' as const, value: 'direct_manager' } }];
    const a = await create(w, input, { code: `${stem}A` });
    const b = await create(w, input, { code: `${stem}B` });
    arm('auto_create', a.id);
    await withRelease(
      () => hook.release(),
      async (lock) => {
        const first = lock.track(saveDraft(w, a, node(w.near.userId)));
        await Promise.race([
          hook.reached,
          first.then(() => {
            throw new Error('插入暂停点未到达');
          }),
        ]);
        const second = lock.track(saveDraft(w, b, node(w.head.userId)));
        expect(await settledOrBlocked(w.db, second, 1)).toBe('blocked');
        hook.release();
        expect((await first).status).toBe(200);
        expect((await second).status).toBe(200);
      },
    );
    const av = await autoAt(w, a.id, 'n1');
    const bv = await autoAt(w, b.id, 'n1');
    expect(Number(bv.code.slice(-13)) - Number(av.code.slice(-13))).toBe(1);
    expect(actionsOf(await audits(w, av.id))).toEqual(['auto_create']);
    expect(actionsOf(await audits(w, bv.id))).toEqual(['auto_create']);
    await clean(w.db);
  });

  it('② 同一草稿：甲持头锁，乙等待后 409 且不写变量；刷新重提成功', async () => {
    const w = await s4World(database().db, 's7d-head-lock');
    const p = await create(w, node(w.near.userId));
    const x = await autoAt(w, p.id, 'n1');
    arm('head', p.id);
    await withRelease(
      () => hook.release(),
      async (lock) => {
        const first = lock.track(saveDraft(w, p, node(w.head.userId)));
        await Promise.race([
          hook.reached,
          first.then(() => {
            throw new Error('头锁暂停点未到达');
          }),
        ]);
        const second = lock.track(saveDraft(w, p, [{ ...node(w.near.userId)[0]!, key: 'b_new' }]));
        expect(await settledOrBlocked(w.db, second, 1)).toBe('blocked');
        hook.release();
        expect((await first).status).toBe(200);
        const rejected = await second;
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
      },
    );
    expect(await autoRows(w, p.id)).toHaveLength(1);
    expect((await varRow(w, x.id)).default_value).toBe(w.head.userId);
    await draftOk(w, await readProcess(w, p.id), node(w.near.userId));
    expect((await varRow(w, x.id)).default_value).toBe(w.near.userId);
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create', 'auto_update', 'auto_update']);
    await clean(w.db);
  });

  it('③ 设计器先更新，管理员阻塞后旧 revision 409；刷新重提；反序同值复用、不同值更新并各自审计', async () => {
    const w = await s4World(database().db, 's7d-var-lock');
    const p = await create(w, node(w.near.userId));
    const x = await autoAt(w, p.id, 'n1');
    arm('auto_update', p.id);
    await withRelease(
      () => hook.release(),
      async (lock) => {
        const first = lock.track(saveDraft(w, p, node(w.head.userId)));
        await Promise.race([
          hook.reached,
          first.then(() => {
            throw new Error('更新暂停点未到达');
          }),
        ]);
        const second = lock.track(editVariable(w, x, { defaultValue: w.near.userId }));
        expect(await settledOrBlocked(w.db, second, 1)).toBe('blocked');
        hook.release();
        expect((await first).status).toBe(200);
        const response = await second;
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
      },
    );
    const current = await varRow(w, x.id);
    expect((await editVariable(w, current, { defaultValue: w.near.userId })).status).toBe(200);
    // 管理员已提交；设计器拿到锁后必须读新默认值，不能使用拿锁前的快照。
    const before = await varRow(w, x.id);
    const same = await draftOk(w, await readProcess(w, p.id), node(w.near.userId));
    expect((await varRow(w, x.id)).revision).toBe(before.revision);
    await draftOk(w, same, node(w.head.userId));
    expect((await varRow(w, x.id)).revision).toBe(before.revision + 1);
    expect(actionsOf(await audits(w, x.id)).sort()).toEqual(['auto_create', 'auto_update', 'auto_update', 'update']);
    await clean(w.db);
  });
});
