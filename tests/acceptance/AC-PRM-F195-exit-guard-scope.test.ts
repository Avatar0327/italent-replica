/**
 * F-195 第 2 轮（#372 第 1 轮 P2-1）：既有 exitGuard 在命令事务内重新解析并校验数据范围。
 * 离职入口 create / PATCH / submit / withdraw / DELETE /businesses/:id / activation/retry 的 CommandGuard.before 原来只重过
 * Dimission* 权限链，不看当前数据范围：入口（事务外）放行之后、命令事务之前范围被收空，同键重放仍返回台账里的原 201 / 200。
 * 撤权模型同 AC-PRM-F195-197-replay-guard：授权提供器只在带事务的调用里应用撤权。
 * 每个出口：首次成功 → 事务内范围收空 → 同键重放被拒（能成功两次的出口）；首次执行时事务内范围已空 → 被拒（全部出口，含首次
 * 一定不成功的 retry 与重放时对象已删除的 DELETE）；失败后回查台账同样复核。被拒时业务 / 审计 / 台账 / revision 都不变。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';
import { revocable, snapshot } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';

// 失败后回查：让命令主事务的 guard.before 第一次抛错（模拟并发冲突回滚），runCommand 随后走 replayAfterFailure 的回查出口
const hooks = vi.hoisted(() => ({ failMainTransaction: false }));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<typeof Commands>();
  return {
    ...original,
    runCommand: (...args: Parameters<typeof original.runCommand>) => {
      const [db, ctx, command] = args;
      const guard = command.guard;
      if (!hooks.failMainTransaction || !guard) return original.runCommand(db, ctx, command);
      hooks.failMainTransaction = false;
      let calls = 0;
      const flaky = {
        ...guard,
        before: async (tx: Parameters<typeof guard.before>[0]) => {
          if (calls++ === 0) throw new Error('模拟主事务并发冲突');
          await guard.before(tx);
        },
      };
      return original.runCommand(db, ctx, { ...command, guard: flaky });
    },
  };
});

const database = useTestDb();
const BASE = '/api/tenant/employment';
const TODAY = '2026-10-06';
const LATER = '2026-10-20';
const clock = () => new Date(`${TODAY}T01:00:00.000Z`);

async function exitWorld(label: string) {
  const w = await gateWorld(database().db, label, { today: TODAY });
  const { employee } = await w.hired();
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const call = (method: string, path: string, init: { ifMatch?: number; body?: object; key: string }) =>
    api.request(method, `${BASE}${path}`, {
      ...w.as,
      ifMatch: init.ifMatch,
      idempotencyKey: init.key,
      ...(init.body ? { body: init.body } : {}),
    });
  const snap = () => snapshot(w.db, w.session.tenant.id);
  return { w, employee, rights, call, snap };
}
type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;

type Send = (key: string) => Promise<Response>;
interface ExitOperation {
  readonly name: string;
  readonly prepare: (x: ExitWorld) => Promise<Send>;
  /** 首次能成功、同键重放能命中台账的出口（retry 首次必 409，DELETE 成功后对象已不存在）。 */
  readonly replayable: boolean;
}

const OPERATIONS: readonly ExitOperation[] = [
  {
    name: 'POST /employees/:id/businesses 创建离职申请',
    replayable: true,
    prepare: async (x) => {
      const { revision } = await x.w.session.getEmployee(x.employee.id);
      return (key) =>
        x.call('POST', `/employees/${x.employee.id}/businesses`, { ifMatch: revision, body: leaveBody(LATER), key });
    },
  },
  {
    name: 'PATCH /businesses/:id 编辑离职申请',
    replayable: true,
    prepare: async (x) => {
      const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
      return (key) =>
        x.call('PATCH', `/businesses/${draft.id}`, {
          ifMatch: draft.revision,
          body: { fields: { place: '重放复核地点' } },
          key,
        });
    },
  },
  {
    name: 'POST /businesses/:id/submit 提交',
    replayable: true,
    prepare: async (x) => {
      const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
      return (key) => x.call('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {}, key });
    },
  },
  {
    name: 'POST /businesses/:id/withdraw 撤回',
    replayable: true,
    prepare: async (x) => {
      const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
      const submitted = await x.w.session.request('POST', `/businesses/${draft.id}/submit`, {
        ifMatch: draft.revision,
        body: {},
      });
      expect(submitted.status, await submitted.clone().text()).toBe(200);
      const { revision } = (await submitted.json()) as { revision: number };
      return (key) => x.call('POST', `/businesses/${draft.id}/withdraw`, { ifMatch: revision, body: {}, key });
    },
  },
  {
    name: 'DELETE /businesses/:id 删除（取消）',
    replayable: false,
    prepare: async (x) => {
      const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
      return (key) => x.call('DELETE', `/businesses/${draft.id}`, { ifMatch: draft.revision, key });
    },
  },
  {
    name: 'POST /businesses/:id/activation/retry 生效重试',
    replayable: false,
    prepare: async (x) => {
      const approved = await x.w.createdLeave(x.employee.id, leaveBody(LATER, 'direct'));
      return (key) =>
        x.call('POST', `/businesses/${approved.id}/activation/retry`, { ifMatch: approved.revision, body: {}, key });
    },
  },
];

const rejected = (status: number) => [403, 404].includes(status);

describe.each(OPERATIONS)('F-195 exitGuard 事务内范围复核：$name', (operation) => {
  it.runIf(operation.replayable)('首次成功后事务内范围收空：同键同内容重放被拒，业务 / 审计 / 台账不变', async () => {
    const x = await exitWorld(`f195-guard-replay-${operation.name.length}`);
    const send = await operation.prepare(x);
    const key = randomUUID();
    const first = await send(key);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    const before = await x.snap();
    x.rights.emptyScope = true;
    const replay = await send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await x.snap()).toEqual(before);
  });

  it.runIf(operation.replayable)('对照：范围不变时同键重放返回原响应', async () => {
    const x = await exitWorld(`f195-guard-same-${operation.name.length}`);
    const send = await operation.prepare(x);
    const key = randomUUID();
    const first = await send(key);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    const before = await x.snap();
    const replay = await send(key);
    expect(replay.status).toBe(first.status);
    expect(await replay.json()).toEqual(await first.json());
    expect(await x.snap()).toEqual(before);
  });

  it('首次执行：入口放行但命令事务内范围已空 → 被拒，无任何写入', async () => {
    const x = await exitWorld(`f195-guard-first-${operation.name.length}`);
    const send = await operation.prepare(x);
    const before = await x.snap();
    x.rights.emptyScope = true;
    const response = await send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await x.snap()).toEqual(before);
  });
});

describe('F-195 exitGuard 事务内范围复核：目标部门与失败回查', () => {
  it('PATCH 改部门：命令事务内范围不含目标部门 → 被拒，无任何写入', async () => {
    const x = await exitWorld('f195-guard-department');
    const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
    const before = await x.snap();
    // 范围只含当前部门与该员工：业务本身在范围内，目标部门（调入部门）不在
    x.rights.scope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'management', orgIds: [x.w.from.id], personIds: [x.employee.id] }],
    };
    const response = await x.call('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { fields: { departmentId: x.w.to.id } },
      key: randomUUID(),
    });
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await x.snap()).toEqual(before);
  });

  it('失败后回查台账：回查前范围收空 → 不返回原响应；范围不变则回查命中原响应（证明走的是回查出口）', async () => {
    const x = await exitWorld('f195-guard-recheck');
    const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
    const send: Send = (key) =>
      x.call('PATCH', `/businesses/${draft.id}`, {
        ifMatch: draft.revision,
        body: { fields: { place: '回查复核地点' } },
        key,
      });
    const key = randomUUID();
    const first = await send(key);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await x.snap();

    hooks.failMainTransaction = true;
    const same = await send(key);
    expect(same.status, await same.clone().text()).toBe(200);
    expect(await same.json()).toEqual(await first.json());

    hooks.failMainTransaction = true;
    x.rights.emptyScope = true;
    const replay = await send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction).toBe(false);
    expect(await x.snap()).toEqual(before);
  });
});
