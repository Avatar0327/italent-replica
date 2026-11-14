/**
 * F-326 S4 P2-2：矩阵运行时读取与管理员整体保存的真 PostgreSQL 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 * 交错：审批人推进、解析器已读到启用矩阵的表头 / 列 / 行，尚未读单元格；此时管理员 PUT structure 删旧行加新行。
 * 状态、列、行、单元格必须来自同一份结构：解析器对表头取共享锁，管理员保存排在它后面；去锁则保存先提交，
 * 解析器读到新行的单元格而旧行表里没有它，推进抛 TypeError（matrix-structure.ts 的 byRow.get(...)!.set）。
 * 暂停点用 loadMatrixStructure 的包装：只在被“上膛”后的第一次调用里，把第三条查询（单元格）拖到测试放行之后。
 */
import { type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as MatrixStructure from '../../apps/api/src/modules/approval/matrix-structure.js';
import { counter, matrix, matrixSource, readMatrix, replaceMatrixRows, s4World } from './AC-APV-F326-S4-support.js';
import { settledOrBlocked, withRelease } from './support/pg-interleave.js';

type Step = (...args: unknown[]) => unknown;
type Chain = Record<string | symbol, Step>;

const pause = vi.hoisted(() => ({
  armed: false,
  entered: undefined as (() => void) | undefined,
  gate: Promise.resolve(),
  open: (): void => undefined,
}));

/** 记录 .from().innerJoin().where() 的链式调用，被 await 时才通知“已到暂停点”并等放行后再真正执行。 */
function pausedQuery(start: () => Chain): unknown {
  const calls: [string | symbol, unknown[]][] = [];
  const proxy: unknown = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then')
        return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
          (async () => {
            pause.entered?.();
            await pause.gate;
            let builder = start();
            for (const [name, args] of calls) builder = builder[name]!(...args) as Chain;
            return builder;
          })().then(resolve, reject);
      return (...args: unknown[]) => {
        calls.push([prop, args]);
        return proxy;
      };
    },
  });
  return proxy;
}

function pausedTx(tx: Tx): Tx {
  let selects = 0;
  return new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as Step).bind(target);
      if (prop !== 'select') return bound;
      return (...args: unknown[]) => (++selects === 3 ? pausedQuery(() => bound(...args) as Chain) : bound(...args));
    },
  });
}

vi.mock('../../apps/api/src/modules/approval/matrix-structure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MatrixStructure>();
  return {
    ...actual,
    loadMatrixStructure: (tx: Tx, tenantId: string, matrixId: string) => {
      if (!pause.armed) return actual.loadMatrixStructure(tx, tenantId, matrixId);
      pause.armed = false;
      return actual.loadMatrixStructure(pausedTx(tx), tenantId, matrixId);
    },
  };
});

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(realPostgres)('AC-APV-F326-10 矩阵运行时读取与整体保存交错', () => {
  it('解析器读到表头后管理员整体保存：保存排在后面，推进不抛错，只用同一份旧结构', async () => {
    const w = await s4World(database().db, 'matrix-lock');
    const m = await matrix(w, { rows: [{ cond: [], role: [w.head.userId] }] });
    await w.publishedProcess({
      nodes: [
        counter([{ type: 'specified', value: w.near.userId }], { key: 'a' }),
        counter([matrixSource(m, m.roleId)], { key: 'b', noAssignee: 'exception_admin' }),
      ],
    });
    const instance = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    const first = w.pending(instance)[0]!;
    const replacement = await w.person('合成角色新人', w.staff);

    let release!: () => void;
    pause.gate = new Promise<void>((resolve) => (release = resolve));
    pause.open = release;
    const reached = new Promise<void>((resolve) => (pause.entered = resolve));
    const { advanced, saved, outcome } = await withRelease(
      () => release(),
      async (lock) => {
        pause.armed = true;
        const advance = lock.track(w.taskAction(w.near.userId, first.id, 'approve', instance.revision, {}));
        await reached; // 解析器已读到表头、列、行，尚未读单元格
        const save = lock.track(replaceMatrixRows(w, m, [{ cond: [], role: [replacement.userId] }]));
        const state = await settledOrBlocked(database().db, save, 1);
        release();
        return { advanced: await advance, saved: await save, outcome: state };
      },
    );

    expect(outcome, '整体保存应排在持共享锁的推进之后').toBe('blocked');
    expect(advanced.status, await advanced.clone().text()).toBe(200);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const tasks = w.pending(await w.detail(instance.id));
    expect(tasks.map((task) => [task.nodeKey, task.assigneeUserId])).toEqual([['b', w.head.userId]]);
    expect((await readMatrix(w, m.id)).rows.map((row) => row.cells[m.roleId])).toEqual([[replacement.userId]]);
  });
});
