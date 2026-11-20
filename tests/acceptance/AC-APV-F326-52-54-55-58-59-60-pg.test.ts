/** 生命周期提交前取锁的真实 PG 交错，沿用 S7d / S7e1 的 Vitest 模块边界暂停点。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { cancel } from '../../apps/api/src/modules/approval/actions.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import type * as Lifecycle from '../../apps/api/src/modules/approval/auto-variable-lifecycle.js';
import type * as Store from '../../apps/api/src/modules/approval/store.js';
import type * as Variables from '../../apps/api/src/modules/approval/variables.js';
import type { InstanceView } from './AC-APV-support.js';
import {
  act,
  baseline,
  discard,
  employmentWithdraw,
  enabled,
  instanceState,
  instanceTrigger,
  node,
  personnelSubmitter,
  publishTrigger,
  replacement,
  retired,
  SAVED,
  systemRetirement,
  terminalNodes,
  withdraw,
} from './AC-APV-F326-50-lifecycle-support.js';
import { instanceRow, personnelChange, rejected } from './AC-APV-F326-S4-support.js';
import {
  create,
  dispatch,
  draftOk,
  editVariable,
  publicVar,
  publishWith,
  readProcess,
  s4World,
  specified,
  varRow,
  type S4World,
} from './AC-APV-F326-S7a-support.js';
import { useSubjectMapping } from './support/f048.js';
import { idleInTransaction, lockWaiters, settledOrBlocked, withRelease } from './support/pg-interleave.js';

type Point = 'matched' | 'persisted' | 'before-lock' | 'locked';
type Gate = { match: (ids: readonly string[]) => boolean; point: Point; enter: (tx: Tx) => Promise<void> };
const gates = vi.hoisted(() => [] as Gate[]);
async function pause(point: Point, tx: Tx, ids: readonly string[]) {
  const index = gates.findIndex((gate) => gate.point === point && gate.match(ids));
  if (index >= 0) await gates.splice(index, 1)[0]!.enter(tx);
}

vi.mock('../../apps/api/src/modules/approval/variables.js', async (original) => {
  const actual = await original<typeof Variables>();
  return {
    ...actual,
    lockVariableBatch: async (...args: Parameters<typeof actual.lockVariableBatch>) => {
      const ids = args[2].map((row) => row.id);
      await pause('before-lock', args[0], ids);
      await actual.lockVariableBatch(...args);
      await pause('locked', args[0], ids);
    },
  };
});
vi.mock('../../apps/api/src/modules/approval/auto-variable-lifecycle.js', async (original) => {
  const actual = await original<typeof Lifecycle>();
  return {
    ...actual,
    lockBoundProcess: async (...args: Parameters<typeof actual.lockBoundProcess>) => {
      await pause('matched', args[0], [args[2].processId]);
      await actual.lockBoundProcess(...args);
    },
  };
});
vi.mock('../../apps/api/src/modules/approval/store.js', async (original) => {
  const actual = await original<typeof Store>();
  return {
    ...actual,
    updateInstance: async (...args: Parameters<typeof actual.updateInstance>) => {
      const saved = await actual.updateInstance(...args);
      await pause('persisted', args[0], [saved.id, saved.versionId]);
      return saved;
    },
  };
});
const database = useTestDb();
const mapSubjects = useSubjectMapping();
const world = (label: string) => s4World(database().db, label);
const opener = (promise: Promise<unknown>, label: string) =>
  promise.then(() => {
    throw new Error(`请求提前结束，未到达 ${label}`);
  });

function gate(point: Point, id: string) {
  let reached!: (pid: number) => void;
  let release!: () => void;
  const arrived = new Promise<number>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry = {
    point,
    match: (ids: readonly string[]) => ids.includes(id),
    enter: async (tx: Tx) => {
      const [row] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`));
      reached(row!.pid);
      await held;
    },
  };
  gates.push(entry);
  return {
    wait: (request: Promise<unknown>) => Promise.race([arrived, opener(request, point)]),
    release: () => {
      const at = gates.indexOf(entry);
      if (at >= 0) gates.splice(at, 1);
      release();
    },
  };
}

async function waitsForVariable(db: Db, request: Promise<unknown>, blocker: number) {
  expect(await settledOrBlocked(db, request, 1), '另一事务应等待同一批变量行').toBe('blocked');
  const [row] = rowsOf<{ query: string; blocker: boolean }>(
    await db.execute(sql`SELECT query, ${blocker} = ANY(pg_blocking_pids(pid)) AS blocker FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  expect(row).toMatchObject({ query: expect.stringMatching(/approval_variables.*for update/is), blocker: true });
}

async function clean(w: S4World) {
  expect(await lockWaiters(w.db)).toBe(0);
  expect(await idleInTransaction(w.db)).toBe(0);
}

const complete = async (w: S4World, i: InstanceView) => w.json<InstanceView>(await act(w, i, 'approve'));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('F-326-L 生命周期（真 PG 强制交错，PGlite 跳过）', () => {
  it('AC-52 ① 通过先取 X、撤回等 X，后者重新读取并且只停用一次', async () => {
    const w = await world('interleave-last-withdraw');
    const { a, x } = await baseline(w);
    const i1 = await complete(w, (await dispatch(w)).instance);
    const person = await w.person('合成并发员工', w.child);
    const i2 = (await dispatch(w, person.employeeId)).instance;
    await w.publish(await replacement(w, a));
    const held = gate('locked', x.id);
    await withRelease(held.release, async ({ track }) => {
      const first = track(act(w, i1, 'approve'));
      const pid = await held.wait(first);
      const second = track(employmentWithdraw(w, i2));
      await waitsForVariable(w.db, second, pid);
      await enabled(w, x);
      held.release();
      expect((await w.json<InstanceView>(await first)).status).toBe('approved');
      await w.json(await second);
    });
    await systemRetirement(w, x, a, instanceTrigger(i2.id, 'withdrawn'));
    await clean(w);
  });

  it.each([false, true])('AC-52 ②④ 均已写实例再同时进提交前，共享变量跨流程=%s', async (cross) => {
    const w = await world(`interleave-shared-${cross}`);
    const { a, x } = await baseline(w);
    const i1 = await complete(w, (await dispatch(w)).instance);
    const b = cross
      ? await w.publish(
          await create(w, [node('b', publicVar(x.id))], {
            approvalType: 'personnel_change',
          }),
        )
      : a;
    const person = await w.person('合成第二位员工', w.child);
    const i2 = cross
      ? (await (await personnelChange(w)).submit()).instance
      : await complete(w, (await dispatch(w, person.employeeId)).instance);
    await w.publish(await replacement(w, a));
    if (cross) await w.publish(await replacement(w, b));
    const l1 = gate('persisted', i1.id);
    const l2 = gate('persisted', i2.id);
    await withRelease(
      () => {
        l1.release();
        l2.release();
      },
      async ({ track }) => {
        const one = track(act(w, i1, 'approve'));
        const two = track(act(w, i2, 'approve'));
        await Promise.all([l1.wait(one), l2.wait(two)]);
        l1.release();
        l2.release();
        for (const response of await Promise.all([one, two])) {
          expect((await w.json<InstanceView>(response)).status).toBe('approved');
        }
      },
    );
    const [entry] = await retired(w, x);
    const second = (entry?.after?.trigger as { instanceId?: string } | undefined)?.instanceId === i2.id;
    await systemRetirement(w, x, second ? b : a, instanceTrigger(second ? i2.id : i1.id, 'approved'));
    await clean(w);
  });

  it('AC-52 ③ 两个批量事务按相反顺序逐单作废，提交前合并锁 X / Y', async () => {
    const w = await world('interleave-batch');
    const { a, x } = await baseline(w);
    const { a: b, x: y } = await baseline(w, 'personnel_change');
    const person = await w.person('合成第二位申请人', w.child);
    const submit = await personnelSubmitter(w);
    const transfer1 = (await dispatch(w)).instance;
    const transfer2 = (await dispatch(w, person.employeeId)).instance;
    const change1 = await submit(w.subject);
    const change2 = await submit(person);
    const j1 = await w.json<InstanceView>(await act(w, transfer1, 'reject'));
    const j2 = await w.json<InstanceView>(await act(w, transfer2, 'reject'));
    const k1 = await w.json<InstanceView>(await act(w, change1, 'reject'));
    const k2 = await w.json<InstanceView>(await act(w, change2, 'reject'));
    await w.publish(await replacement(w, a));
    await w.publish(await replacement(w, b));
    const l1 = gate('persisted', j1.id);
    const l2 = gate('persisted', k2.id);
    const batch = (first: InstanceView, second: InstanceView) =>
      withTenant(w.db, w.tenant.id, async (tx) => {
        const ctx = {
          tenantId: w.tenant.id,
          userId: w.hr.id,
          now: w.clock(),
          timezone: 'Asia/Shanghai',
          commandId: randomUUID(),
          expectedRevision: 0,
        };
        await cancel(tx, ctx, first.id);
        await cancel(tx, ctx, second.id);
      });
    await withRelease(
      () => {
        l1.release();
        l2.release();
      },
      async ({ track }) => {
        const first = track(batch(j1, k1));
        const second = track(batch(k2, j2));
        await Promise.all([l1.wait(first), l2.wait(second)]);
        l1.release();
        l2.release();
        await Promise.all([first, second]);
      },
    );
    for (const i of [j1, j2, k1, k2]) expect((await instanceRow(w, i.id)).status).toBe('cancelled');
    const [entry] = await retired(w, x);
    const second = (entry?.after?.trigger as { instanceId?: string } | undefined)?.instanceId === j2.id;
    await systemRetirement(w, x, a, instanceTrigger((second ? j2 : j1).id, 'cancelled'));
    await systemRetirement(w, y, b, instanceTrigger((second ? k2 : k1).id, 'cancelled'));
    await clean(w);
  });

  it.each(['publish', 'discard'] as const)('AC-54 ①③ 匹配后暂停，%s 提交先于流程头重验', async (change) => {
    const w = await world(`interleave-bind-${change}`);
    const { a, x } = await baseline(w);
    const v2 = change === 'publish' ? await replacement(w, a) : null;
    const business = await w.application(w.subject.employeeId, { departmentId: w.staff });
    const initial = await w.business(business.id);
    const bound = gate('matched', a.id);
    await withRelease(bound.release, async ({ track }) => {
      const submit = track(w.submitRaw(business));
      await bound.wait(submit);
      if (v2) await w.publish(v2);
      else await w.json(await discard(w, a));
      bound.release();
      expect(await rejected(await submit, 409, 'APPROVAL_PROCESS_VERSION_CHANGED')).toMatchObject({
        code: 'CONFLICT',
        message: '流程已更新，请重新发起',
      });
    });
    expect(await w.business(business.id)).toEqual(initial);
    const inserted = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT id FROM approval_instances WHERE tenant_id=${w.tenant.id}
        AND business_id=${business.id}::uuid`),
      ),
    );
    expect(inserted).toEqual([]);
    if (v2) {
      await systemRetirement(w, x, a, publishTrigger(v2));
      expect((await instanceRow(w, (await w.submit(business)).id)).version_id).toBe(v2.latestVersion.id);
    } else {
      await systemRetirement(w, x, a, { kind: 'discard' }, '作废流程在途单清零自动停用');
    }
    await clean(w);
  });

  it.each([false, true])('AC-55 ④ 撤回重提与最后一单结束争用 X，重提先锁=%s', async (resumeFirst) => {
    const w = await world(`interleave-resume-${resumeFirst}`);
    const { a, x } = await baseline(w, 'personnel_change');
    const submit = await personnelSubmitter(w);
    const i = await w.json<InstanceView>(await withdraw(w, await submit(w.subject)));
    const secondPerson = await w.person('合成在途发起人', w.child);
    const j = await complete(w, await submit(secondPerson));
    await w.publish(await replacement(w, a));
    await enabled(w, x);
    const resume = () => w.instanceAction(w.subject.userId, i.id, 'resubmit', i.revision);
    const finish = () => act(w, j, 'approve');
    const held = gate('locked', x.id);
    await withRelease(held.release, async ({ track }) => {
      const first = track(resumeFirst ? resume() : finish());
      const pid = await held.wait(first);
      const second = track(resumeFirst ? finish() : resume());
      await waitsForVariable(w.db, second, pid);
      held.release();
      await w.json(await first);
      if (resumeFirst) await w.json(await second);
      else await rejected(await second, 409, 'APPROVAL_PROCESS_UPDATED_RESTART');
    });
    expect((await instanceRow(w, i.id)).status).toBe(resumeFirst ? 'running' : 'withdrawn');
    if (resumeFirst) await enabled(w, x);
    else await systemRetirement(w, x, a, instanceTrigger(j.id, 'approved'));
    await clean(w);
  });

  it.each([false, true])('AC-58 ② 保存移除 B 草稿引用 × A 最后一单通过，保存先锁=%s', async (saveFirst) => {
    const w = await world(`interleave-save-${saveFirst}`);
    const { a, x } = await baseline(w);
    const b = await create(w, [node('b', publicVar(x.id))], { approvalType: 'personnel_change' });
    const i = await complete(w, (await dispatch(w)).instance);
    await w.publish(await replacement(w, a));
    const save = () => draftOk(w, b, [node('b')]);
    const finish = () => act(w, i, 'approve');
    const lock = gate('locked', x.id);
    const early = gate('before-lock', x.id);
    const late = gate('before-lock', x.id);
    await withRelease(
      () => {
        lock.release();
        early.release();
        late.release();
      },
      async ({ track }) => {
        const first = track(saveFirst ? save() : finish());
        await early.wait(first);
        const second = track(saveFirst ? finish() : save());
        await late.wait(second);
        early.release();
        const pid = await lock.wait(first);
        late.release();
        await waitsForVariable(w.db, second, pid);
        lock.release();
        const results = await Promise.all([first, second]);
        await w.json((saveFirst ? results[1] : results[0]) as Response);
      },
    );
    if (saveFirst) await systemRetirement(w, x, a, instanceTrigger(i.id, 'approved'));
    else {
      expect((await varRow(w, x.id)).status).toBe('disabled');
      expect(await retired(w, x)).toMatchObject([{ actor: w.hr.id, after: { reason: SAVED } }]);
    }
    await clean(w);
  });

  it('AC-51 ③ / AC-59 ① 两个发起即通过的实例兼容版本外键，只在变量处等待', async () => {
    const w = await world('interleave-automatic-launch');
    const { a, x } = await baseline(w, 'transfer', terminalNodes(w));
    mapSubjects(() => [w.head.employeeId]);
    const person = await w.person('合成并发对象', w.child);
    const first = await w.application(w.subject.employeeId, { departmentId: w.staff });
    const second = await w.application(person.employeeId, { departmentId: w.staff });
    const l1 = gate('persisted', a.latestVersion.id);
    const l2 = gate('persisted', a.latestVersion.id);
    const held = gate('locked', x.id);
    await withRelease(
      () => {
        l1.release();
        l2.release();
        held.release();
      },
      async ({ track }) => {
        const one = track(w.submitRaw(first));
        await l1.wait(one);
        const two = track(w.submitRaw(second));
        await l2.wait(two);
        l1.release();
        l2.release();
        const pid = await held.wait(Promise.all([one, two]));
        await waitsForVariable(w.db, Promise.all([one, two]), pid);
        held.release();
        await w.json(await one);
        await w.json(await two);
      },
    );
    for (const business of [first, second]) {
      const i = await w.instanceOf(business.id);
      expect(i.status).toBe('approved');
      expect((await instanceState(w, i.id)).version_id).toBe(a.latestVersion.id);
    }
    await enabled(w, x);
    await clean(w);
  });

  it.each([false, true])('AC-60 returned 重提当场通过 × 发布，重提先锁=%s', async (resumeFirst) => {
    const w = await world(`interleave-returned-${resumeFirst}`);
    const { a, x } = await baseline(w, 'personnel_change', [
      node('n1', specified(w.head.userId)),
      node('n2', specified(w.near.userId), { historySameAssigneeSkip: true, rejectResubmit: 'rejecting_node' }),
    ]);
    const { instance } = await (await personnelChange(w)).submit();
    const i = await w.json<InstanceView>(await act(w, await complete(w, instance), 'reject'));
    expect(i.status).toBe('returned');
    const v2 = await replacement(w, a);
    await w.json(await editVariable(w, x, { defaultValue: w.head.userId }));
    const current = await varRow(w, x.id);
    const submit = () => w.instanceAction(w.subject.userId, i.id, 'resubmit', i.revision);
    const publish = () => publishWith(w, v2);
    const held = gate('locked', x.id);
    await withRelease(held.release, async ({ track }) => {
      const first = track(resumeFirst ? submit() : publish());
      const pid = await held.wait(first);
      const second = track(resumeFirst ? publish() : submit());
      await waitsForVariable(w.db, second, pid);
      await enabled(w, x);
      held.release();
      await w.json(await first);
      await w.json(await second);
    });
    expect((await instanceState(w, i.id)).status).toBe('approved');
    expect((await readProcess(w, a.id)).currentVersion!.id).toBe(v2.latestVersion.id);
    await systemRetirement(w, current, a, resumeFirst ? publishTrigger(v2) : instanceTrigger(i.id, 'approved'));
    await clean(w);
  });
});
