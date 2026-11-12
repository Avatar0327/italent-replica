/** F-326-L §2.3 / 主设计 §8 C2：同一套契约分别由 PGlite 与真 PG（app_owner）执行。 */
import {
  afterTransactionCommit,
  approvalVariables,
  beforeTransactionCommit,
  eq,
  sql,
  type Tx,
  withTenant,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import { seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

async function fixture() {
  const { tenant, user } = await seedTenantWithMember(database().db, 'f326-c2');
  const values = {
    tenantId: tenant.id,
    scope: 'public',
    code: `Global.B.C${uniqueSuffix()}`,
    name: '合成提交前变量',
    dataType: 'string',
    usageScopes: ['process'],
    createdBy: user.id,
    updatedBy: user.id,
  };
  const read = () =>
    withTenant(database().db, tenant.id, (tx) => tx.select({ name: approvalVariables.name }).from(approvalVariables));
  return { tenantId: tenant.id, values, read };
}

it('AC-APV-F326-C2：回调结束后同键追加一次 flush，使用根事务句柄并先于 after-commit', async () => {
  const { tenantId, values, read } = await fixture();
  const events: string[] = [];
  let root!: Tx;
  const flush = vi.fn(async (tx: Tx, payloads: string[]) => {
    expect(tx).toBe(root);
    expect(payloads).toEqual(['初值', '最终值']);
    expect(events).toEqual(['body-end']);
    expect(await tx.select({ name: approvalVariables.name }).from(approvalVariables)).toEqual([
      { name: '合成提交前变量' },
    ]);
    await tx.update(approvalVariables).set({ name: payloads[1]! }).where(eq(approvalVariables.code, values.code));
    events.push('flush');
    afterTransactionCommit(tx, 'from-flush', async () => {
      expect(await read()).toEqual([{ name: '最终值' }]);
      events.push('after');
    });
  });
  const result = await withTenant(database().db, tenantId, async (tx) => {
    root = tx;
    await tx.insert(approvalVariables).values(values);
    beforeTransactionCommit(tx, 'batch', '初值', flush);
    beforeTransactionCommit(tx, 'batch', '最终值', flush);
    expect(flush).not.toHaveBeenCalled();
    events.push('body-end');
    return { saved: true };
  });
  expect(result).toEqual({ saved: true });
  expect(flush).toHaveBeenCalledTimes(1);
  expect(events).toEqual(['body-end', 'flush', 'after']);
});

it('AC-APV-F326-C2：任意深度保存点成功只合并，父子同键追加、不同键各执行一次', async () => {
  const batches: unknown[] = [];
  let root!: Tx;
  const flush = vi.fn(async (tx: Tx, payloads: number[]) => {
    expect(tx).toBe(root);
    batches.push([...payloads]);
  });
  await database().db.transaction(async (tx) => {
    root = tx;
    beforeTransactionCommit(tx, 'same', 1, flush);
    await tx.transaction(async (child) => {
      beforeTransactionCommit(child, 'same', 2, flush);
      await child.transaction(async (grandchild) => {
        beforeTransactionCommit(grandchild, 'same', 3, flush);
        beforeTransactionCommit(grandchild, 'other', 4, flush);
      });
      expect(flush).not.toHaveBeenCalled();
    });
    beforeTransactionCommit(tx, 'same', 5, flush);
    expect(flush).not.toHaveBeenCalled();
  });
  expect(flush).toHaveBeenCalledTimes(2);
  expect(batches).toEqual([[1, 2, 3, 5], [4]]);
});

it('AC-APV-F326-C2：失败保存点丢弃自身与已合并后代，父任务和成功兄弟保留', async () => {
  const flush = vi.fn(async (_tx: Tx, _payloads: number[]) => undefined);
  const discarded = vi.fn(async (_tx: Tx, _payloads: number[]) => undefined);
  await database().db.transaction(async (tx) => {
    beforeTransactionCommit(tx, 'same', 1, flush);
    await expect(
      tx.transaction(async (child) => {
        beforeTransactionCommit(child, 'same', 2, discarded);
        await child.transaction(async (grandchild) => {
          beforeTransactionCommit(grandchild, 'child-only', 3, discarded);
        });
        throw new Error('合成保存点失败');
      }),
    ).rejects.toThrow('合成保存点失败');
    await tx.transaction(async (sibling) => {
      beforeTransactionCommit(sibling, 'same', 4, flush);
    });
  });
  expect(flush).toHaveBeenCalledTimes(1);
  expect(flush.mock.calls[0]![1]).toEqual([1, 4]);
  expect(discarded).not.toHaveBeenCalled();
});

it('AC-APV-F326-C2：根事务主体失败，成功保存点的登记也丢弃且写入回滚', async () => {
  const { tenantId, values, read } = await fixture();
  const flush = vi.fn(async () => undefined);
  const after = vi.fn(async () => undefined);
  await expect(
    withTenant(database().db, tenantId, async (tx) => {
      await tx.insert(approvalVariables).values(values);
      await tx.transaction(async (child) => {
        beforeTransactionCommit(child, 'batch', 1, flush);
        afterTransactionCommit(child, 'after', after);
      });
      throw new Error('合成主体失败');
    }),
  ).rejects.toThrow('合成主体失败');
  expect(flush).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
  expect(await read()).toEqual([]);
});

it.each(['同步', '异步'] as const)('AC-APV-F326-C2：%s flush 抛错使主体与此前 flush 写入全部回滚', async (mode) => {
  const { tenantId, values, read } = await fixture();
  const failure = new Error('合成提交前失败');
  const after = vi.fn(async () => undefined);
  const flushed: string[] = [];
  await expect(
    withTenant(database().db, tenantId, async (tx) => {
      await tx.insert(approvalVariables).values(values);
      beforeTransactionCommit(tx, 'first', '已执行', async (current, payloads) => {
        await current.update(approvalVariables).set({ name: payloads[0]! });
        flushed.push('first');
      });
      beforeTransactionCommit(tx, 'broken', null, (current) => {
        flushed.push('broken');
        if (mode === '同步') throw failure;
        return current.execute(sql`SELECT 1`).then(() => {
          throw failure;
        });
      });
      afterTransactionCommit(tx, 'after', after);
    }),
  ).rejects.toBe(failure);
  expect(flushed).toEqual(['first', 'broken']);
  expect(after).not.toHaveBeenCalled();
  expect(await read()).toEqual([]);
});

it('AC-APV-F326-C2：未管理、已提交及已回滚的事务句柄拒绝登记', async () => {
  const flush = vi.fn(async () => undefined);
  expect(() => beforeTransactionCommit({} as Tx, 'batch', 1, flush)).toThrow('当前有效事务');
  let closed!: Tx;
  let rolledBack!: Tx;
  await database().db.transaction(async (tx) => {
    closed = tx;
    await expect(
      tx.transaction(async (child) => {
        rolledBack = child;
        throw new Error('合成回滚');
      }),
    ).rejects.toThrow('合成回滚');
    expect(() => beforeTransactionCommit(rolledBack, 'batch', 1, flush)).toThrow('当前有效事务');
  });
  expect(() => beforeTransactionCommit(closed, 'batch', 1, flush)).toThrow('当前有效事务');
  expect(flush).not.toHaveBeenCalled();
});

it('AC-APV-F326-C2：独立根事务的同名 key 相互隔离，空事务保持原返回值', async () => {
  const flush = vi.fn(async (_tx: Tx, _payloads: number[]) => undefined);
  await Promise.all(
    [1, 2].map((payload) =>
      database().db.transaction(async (tx) => {
        beforeTransactionCommit(tx, 'same', payload, flush);
        await tx.execute(sql`SELECT 1`);
      }),
    ),
  );
  expect(flush).toHaveBeenCalledTimes(2);
  expect(flush.mock.calls.map((call) => call[1]).sort()).toEqual([[1], [2]]);
  expect(await database().db.transaction(async () => '空事务')).toBe('空事务');
});
