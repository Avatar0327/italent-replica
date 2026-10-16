/**
 * F-195 第 2 轮（#372 第 1 轮 P2-1）：既有 exitGuard 在命令事务内重新解析并校验数据范围。
 * 离职入口 create / PATCH / submit / withdraw / DELETE /businesses/:id / activation/retry 的 CommandGuard.before 原来只重过
 * Dimission* 权限链，不看当前数据范围：入口（事务外）放行之后、命令事务之前范围被收空，同键重放仍返回台账里的原 201 / 200。
 * 撤权模型同 AC-PRM-F195-197-replay-guard：授权提供器只在带事务的调用里应用撤权。
 * 每个出口：首次成功 → 事务内范围收空 → 同键重放被拒；首次执行时事务内范围已空 → 被拒；失败后回查台账同样复核。
 * 第 3 轮（#372 第 2 轮 P2-1 续）：范围不是收空而是收窄到只剩 A 或只剩 B——创建继承到的部门、已有业务的员工当前范围。
 * DELETE 只追加 deleted 状态、业务头仍可查，能命中原台账；无离职扩展行的旧版离职申请 retry 可成功，也都能成功重放。
 * 第 4 轮（#372 第 3 轮 P2-1 / P2-2）：事务内重新解析的范围同时用于前置检查、实际执行、提交前结果校验和重放复核——
 * 首次执行时范围就已收窄到只剩 A（创建继承到 B）要被拒；重放 / 回查还要校验台账里原响应快照（原 201 带 B，业务当前值已改到 A）。
 * 被拒时业务 / 审计 / 台账 / revision 都不变。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';
import { orgScope as orgScopeOf, revocable, snapshot } from './support/revocable-rights.js';
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
  /** 首次成功、同键重放命中台账的出口（全部出口都可以）。 */
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
    replayable: true,
    prepare: async (x) => {
      const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
      return (key) => x.call('DELETE', `/businesses/${draft.id}`, { ifMatch: draft.revision, key });
    },
  },
  {
    name: 'POST /businesses/:id/activation/retry 生效重试（无离职扩展行的旧版离职申请）',
    replayable: true,
    prepare: async (x) => {
      // 可信造数的旧版离职申请没有离职扩展行：批准后生效重试走原有路径（成功时 200），不经 B3-3 的 409
      const id = await x.w.synthetic(x.employee.id, { kind: 'leave', state: 'approved', effectiveDate: '2026-10-05' });
      // 批准后的一次生效尝试已失败（定时任务只排除有离职扩展行的申请，旧版无扩展行的离职申请仍会进入调度；这里直接造“失败”的尝试记录）
      await x.w.sqlRows(sql`INSERT INTO employment_activation_attempts
          (tenant_id, employee_id, business_id, attempt_no, outcome, reason, business_date, trigger, command_id)
        VALUES (${x.w.session.tenant.id}, ${x.employee.id}::uuid, ${id}::uuid, 1, 'failed', 'SYNTHETIC_FAILURE',
          '2026-10-05'::date, 'scheduler', 'synthetic-attempt')`);
      const business = await x.w.session.request('GET', `/businesses/${id}`);
      expect(business.status, await business.clone().text()).toBe(200);
      const { revision } = (await business.json()) as { revision: number };
      return (key) => x.call('POST', `/businesses/${id}/activation/retry`, { ifMatch: revision, body: {}, key });
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

// ---- 第 3 轮：非空范围收窄 -----------------------------------------------------------------------------------------

const orgScope = (x: ExitWorld, ...orgIds: string[]): ModuleScope =>
  orgScopeOf(x.w.session.tenant.id, TODAY, ...orgIds);

/** 员工当前在调出部门 A；已有一条 10-15 起调往调入部门 B 的直接任职。10-20 的离职申请实际继承 B。 */
async function inheritWorld(label: string) {
  const x = await exitWorld(label);
  const { revision } = await x.w.session.getEmployee(x.employee.id);
  await x.w.session.business(
    x.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-15', fields: { departmentId: x.w.to.id } },
    revision,
  );
  return x;
}

interface NarrowCase {
  readonly name: string;
  /** 首次成功后收窄到的范围（只剩 A 或只剩 B）。 */
  readonly narrowed: (x: ExitWorld) => ModuleScope;
  /** 对照：合法请求——范围同时含 A 与 B。 */
  readonly allowed: (x: ExitWorld) => ModuleScope;
  readonly prepare: (x: ExitWorld) => Promise<Send>;
}

const NARROW_CASES: readonly NarrowCase[] = [
  {
    // 反例 1：创建时没填部门，实际继承 B；范围收窄到只剩 A，重放不能再返回带 B 数据的原 201
    name: '创建离职申请继承到调入部门 B：范围收窄到只剩 A',
    narrowed: (x) => orgScope(x, x.w.from.id),
    allowed: (x) => orgScope(x, x.w.from.id, x.w.to.id),
    prepare: async (x) => {
      const { revision } = await x.w.session.getEmployee(x.employee.id);
      return (key) =>
        x.call('POST', `/employees/${x.employee.id}/businesses`, { ifMatch: revision, body: leaveBody(LATER), key });
    },
  },
  {
    // 反例 2：员工当前在 A，离职单部门是 B；范围收窄到只剩 B，业务在范围内但员工当前不在
    name: 'PATCH 离职申请（部门 B）：员工当前在 A，范围收窄到只剩 B',
    narrowed: (x) => orgScope(x, x.w.to.id),
    allowed: (x) => orgScope(x, x.w.from.id, x.w.to.id),
    prepare: async (x) => {
      const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
      expect((draft as unknown as { fields: { departmentId: string } }).fields.departmentId).toBe(x.w.to.id);
      return (key) =>
        x.call('PATCH', `/businesses/${draft.id}`, {
          ifMatch: draft.revision,
          body: { fields: { place: '收窄复核地点' } },
          key,
        });
    },
  },
  {
    name: 'submit 离职申请（部门 B）：员工当前在 A，范围收窄到只剩 B',
    narrowed: (x) => orgScope(x, x.w.to.id),
    allowed: (x) => orgScope(x, x.w.from.id, x.w.to.id),
    prepare: async (x) => {
      const draft = await x.w.createdLeave(x.employee.id, leaveBody(LATER));
      return (key) => x.call('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {}, key });
    },
  },
];

describe.each(NARROW_CASES)('F-195 exitGuard 非空范围收窄：$name', (c) => {
  it('首次成功后收窄：同键同内容重放被拒，业务 / 审计 / 台账不变', async () => {
    const x = await inheritWorld(`f195-narrow-replay-${c.name.length}`);
    const send = await c.prepare(x);
    const key = randomUUID();
    const first = await send(key);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    const before = await x.snap();
    x.rights.scope = c.narrowed(x);
    const replay = await send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await replay.clone().text()).not.toContain(x.w.to.id);
    expect(await x.snap()).toEqual(before);
  });

  it('失败后回查：回查前收窄 → 被拒；范围含 A 与 B 时回查命中原响应', async () => {
    const x = await inheritWorld(`f195-narrow-recheck-${c.name.length}`);
    const send = await c.prepare(x);
    const key = randomUUID();
    const first = await send(key);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    const before = await x.snap();

    x.rights.scope = c.allowed(x);
    hooks.failMainTransaction = true;
    const same = await send(key);
    expect(same.status, await same.clone().text()).toBe(first.status);
    expect(await same.json()).toEqual(await first.json());

    x.rights.scope = c.narrowed(x);
    hooks.failMainTransaction = true;
    const replay = await send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction).toBe(false);
    expect(await x.snap()).toEqual(before);
  });

  it('对照：范围含 A 与 B 的合法请求，同键重放返回原响应', async () => {
    const x = await inheritWorld(`f195-narrow-same-${c.name.length}`);
    const send = await c.prepare(x);
    const key = randomUUID();
    const first = await send(key);
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    const before = await x.snap();
    x.rights.scope = c.allowed(x);
    const replay = await send(key);
    expect(replay.status).toBe(first.status);
    expect(await replay.json()).toEqual(await first.json());
    expect(await x.snap()).toEqual(before);
  });
});

// ---- 第 4 轮：首次执行用事务内范围 + 重放复核原响应快照 ----------------------------------------------------------------

describe.each(NARROW_CASES)('F-195 事务内范围贯穿首次执行与结果校验：$name', (c) => {
  it('首次执行：入口放行但命令事务内范围已收窄 → 被拒，业务 / 审计 / 台账 / revision 都不变', async () => {
    const x = await inheritWorld(`f195-first-narrow-${c.name.length}`);
    const send = await c.prepare(x);
    const before = await x.snap();
    x.rights.scope = c.narrowed(x);
    const response = await send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await x.snap()).toEqual(before);
  });

  it('对照：命令事务内范围含 A 与 B 的合法首次请求照常成功', async () => {
    const x = await inheritWorld(`f195-first-allowed-${c.name.length}`);
    const send = await c.prepare(x);
    x.rights.scope = c.allowed(x);
    const response = await send(randomUUID());
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  });
});

/** 首次创建返回部门 B 的 201；随后一次合法 PATCH 把这条申请改到 A：业务当前值是 A，台账里的原响应仍带 B。 */
async function createdThenMovedToA(label: string) {
  const x = await inheritWorld(label);
  const { revision } = await x.w.session.getEmployee(x.employee.id);
  const send: Send = (key) =>
    x.call('POST', `/employees/${x.employee.id}/businesses`, { ifMatch: revision, body: leaveBody(LATER), key });
  const key = randomUUID();
  const first = await send(key);
  expect(first.status, await first.clone().text()).toBe(201);
  const created = (await first.clone().json()) as { id: string; revision: number; fields: { departmentId: string } };
  expect(created.fields.departmentId).toBe(x.w.to.id);
  const moved = await x.call('PATCH', `/businesses/${created.id}`, {
    ifMatch: created.revision,
    body: { fields: { departmentId: x.w.from.id } },
    key: randomUUID(),
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  return { x, send, key, first };
}

describe('F-195 重放复核原响应快照：原 201 带 B，业务当前值已改到 A，范围收窄到只剩 A', () => {
  it('直接重放：被拒，不返回带 B 的原响应，业务 / 审计 / 台账 / revision 不变', async () => {
    const { x, send, key } = await createdThenMovedToA('f195-snapshot-direct');
    const before = await x.snap();
    x.rights.scope = orgScope(x, x.w.from.id);
    const replay = await send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await replay.clone().text()).not.toContain(x.w.to.id);
    expect(await x.snap()).toEqual(before);
  });

  it('失败后回查：同样被拒；范围含 A 与 B 时回查命中原响应（证明走的是回查出口）', async () => {
    const { x, send, key, first } = await createdThenMovedToA('f195-snapshot-recheck');
    const before = await x.snap();

    x.rights.scope = orgScope(x, x.w.from.id, x.w.to.id);
    hooks.failMainTransaction = true;
    const same = await send(key);
    expect(same.status, await same.clone().text()).toBe(201);
    expect(await same.json()).toEqual(await first.json());

    x.rights.scope = orgScope(x, x.w.from.id);
    hooks.failMainTransaction = true;
    const replay = await send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await replay.clone().text()).not.toContain(x.w.to.id);
    expect(hooks.failMainTransaction).toBe(false);
    expect(await x.snap()).toEqual(before);
  });

  it('对照：范围含 A 与 B 的合法请求，同键重放仍返回原响应', async () => {
    const { x, send, key, first } = await createdThenMovedToA('f195-snapshot-same');
    const before = await x.snap();
    x.rights.scope = orgScope(x, x.w.from.id, x.w.to.id);
    const replay = await send(key);
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(await x.snap()).toEqual(before);
  });
});
