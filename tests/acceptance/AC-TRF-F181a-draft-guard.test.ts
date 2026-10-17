/**
 * F-181a（#403 第 1 轮返工 P2-2 / P2-4 / P2-5）：暂存覆盖、清除与读口的授权。
 * ① 清除走与 DELETE /businesses/:id 同一条删除授权链：有发起权无删除权 → 403，状态 / 审计 / 台账 / 槽位都不变；
 * ② 覆盖暂存（POST）与清除（DELETE）接 CommandGuard.before：入口放行、命令事务内已撤权 / 范围已空 → 被拒，
 *    旧暂存单仍是草稿，同键重放与失败后回查同样按当前授权复核；
 * ③ 元数据读口按任职记录字段查看权投影（只给 id / revision 时不返回 effectiveDate 等业务值）。
 * 撤权模型同 AC-PRM-F202-guard-pending-and-record-edit：入口复核放行，授权提供器只在带事务的调用里应用撤权。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { BASE, clock, D, saved, slotWorld, type SlotWorld } from './AC-TRF-F181a-support.js';
import {
  emptyScope,
  isButton,
  revocable,
  revoke,
  snapshot,
  type Request,
  type Revoker,
} from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';

// 失败后回查：让命令主事务的 guard.before 第一次抛错，runCommand 随后走 replayAfterFailure 的回查出口；
// 路径上没有 guard 时原样透传，hooks.failMainTransaction 保持为真——用例据此证明回查出口确实经过了 guard。
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
const rejected = (status: number) => status === 403 || status === 404;
const deniesObjectCreate = (request: Request) =>
  request.action === 'object.create' && (request.fields?.length ?? 0) === 0;
const deniesObjectDelete = (request: Request) => request.action === 'object.delete';

beforeEach(() => {
  hooks.failMainTransaction = false;
});

async function guardedWorld(label: string) {
  const s = await slotWorld(database().db, label);
  const { authorize, rights } = revocable();
  const api = tenantApi(s.w.db, { authorize, clock });
  const as = { user: s.w.session.user.id, tenant: s.tenantId };
  const send = (method: string, path: string, options: { ifMatch?: number; key: string; body?: object }) =>
    api.request(method, `${BASE}${path}`, {
      ...as,
      ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      idempotencyKey: options.key,
      ...(options.body ? { body: options.body } : {}),
    });
  const stashBody = (body: Record<string, unknown> = {}) => ({
    initiator: 'hr',
    transferTypeCode: 'cross_department',
    mode: 'application',
    submit: false,
    effectiveDate: D,
    fields: { departmentId: s.w.to.id },
    ...body,
  });
  return {
    ...s,
    rights,
    api,
    /** 经可撤权授权器的覆盖暂存。 */
    guardedStash: async (key: string, body: Record<string, unknown> = {}, revision?: number) =>
      send('POST', `/transfers/employees/${s.employeeId}`, {
        ifMatch: revision ?? (await s.w.session.getEmployee(s.employeeId)).revision,
        key,
        body: stashBody(body),
      }),
    guardedClear: (businessId: string, revision: number, key: string) =>
      send('DELETE', `/transfers/employees/${s.employeeId}/draft/${businessId}`, { ifMatch: revision, key }),
    guardedRead: () => api.request('GET', `${BASE}/transfers/employees/${s.employeeId}/draft`, as),
  };
}

/** 业务 / 审计 / 台账快照 + 槽位指针与暂存单状态（被拒后逐项相等）。 */
async function state(x: Pick<SlotWorld, 'w' | 'tenantId' | 'slots'>) {
  const base = await snapshot(x.w.db, x.tenantId);
  const slots = await x.slots();
  const states = await withTenant(x.w.db, x.tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT business_id, state FROM employment_state_events
      WHERE tenant_id=${x.tenantId} ORDER BY business_id, event_no`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as unknown[];
  });
  return { base, slots, states };
}

const REVOKERS: readonly Revoker[] = [
  ['撤掉任职记录对象新建权', revoke(deniesObjectCreate)],
  ['撤掉 Transfer.Hr 发起按钮', revoke(isButton('Transfer.Hr'))],
  ['数据范围收为空', emptyScope],
];
const CLEAR_REVOKERS: readonly Revoker[] = [
  ['撤掉任职记录对象删除权', revoke(deniesObjectDelete)],
  ['撤掉 Employment.Delete 按钮', revoke(isButton('Employment.Delete'))],
  ['撤掉 Transfer.Hr 发起按钮', revoke(isButton('Transfer.Hr'))],
  ['数据范围收为空', emptyScope],
];

describe('F-181a P2-4 覆盖暂存接 CommandGuard.before', () => {
  it.each(REVOKERS)('首次执行：入口放行但命令内已%s → 被拒，旧暂存单仍是草稿，无任何写入', async (name, apply) => {
    const x = await guardedWorld(`f181a-guard-stash-${name.length}`);
    const old = await saved(await x.guardedStash(randomUUID()));
    const before = await state(x);
    apply(x.rights);
    const response = await x.guardedStash(randomUUID(), { effectiveDate: '2026-10-12' });
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await state(x)).toEqual(before);
    expect(await x.businessState(old.id)).toBe('draft');
  });

  it.each(REVOKERS)(
    '首次成功后%s：同键同内容重放被拒（不返回台账原 201），业务 / 审计 / 台账不变',
    async (name, apply) => {
      const x = await guardedWorld(`f181a-guard-stash-replay-${name.length}`);
      const key = randomUUID();
      const revision = (await x.w.session.getEmployee(x.employeeId)).revision;
      await saved(await x.guardedStash(key, {}, revision));
      const before = await state(x);
      apply(x.rights);
      const replay = await x.guardedStash(key, {}, revision);
      expect(rejected(replay.status), await replay.clone().text()).toBe(true);
      expect(await state(x)).toEqual(before);
    },
  );

  it.each(REVOKERS)('失败后回查台账：回查前%s → 被拒', async (name, apply) => {
    const x = await guardedWorld(`f181a-guard-stash-recheck-${name.length}`);
    const key = randomUUID();
    const revision = (await x.w.session.getEmployee(x.employeeId)).revision;
    await saved(await x.guardedStash(key, {}, revision));
    const before = await state(x);
    hooks.failMainTransaction = true;
    apply(x.rights);
    const replay = await x.guardedStash(key, {}, revision);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await state(x)).toEqual(before);
  });

  it('对照：权限不变时同键重放与失败回查都返回原响应，不重复写入', async () => {
    const x = await guardedWorld('f181a-guard-stash-same');
    const key = randomUUID();
    const revision = (await x.w.session.getEmployee(x.employeeId)).revision;
    const first = await saved(await x.guardedStash(key, {}, revision));
    const before = await state(x);
    const replay = await x.guardedStash(key, {}, revision);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { id: string }).id).toBe(first.id);
    hooks.failMainTransaction = true;
    const recheck = await x.guardedStash(key, {}, revision);
    expect(recheck.status).toBe(201);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await state(x)).toEqual(before);
  });
});

describe('F-181a P2-2 清除走删除授权链并在命令事务内复核', () => {
  it('有发起权、无删除权：DELETE /businesses/:id 与清除都是 403，状态 / 审计 / 台账 / 槽位都不变', async () => {
    const s = await slotWorld(database().db, 'f181a-delete-auth');
    const stash = await saved(await s.save());
    const denied = tenantApi(s.w.db, { authorize: (request) => request.action !== 'object.delete', clock });
    const as = { user: s.w.session.user.id, tenant: s.tenantId };
    const before = await state(s);
    const plain = await denied.request('DELETE', `${BASE}/businesses/${stash.id}`, {
      ...as,
      ifMatch: stash.revision,
    });
    expect(plain.status).toBe(403);
    const cleared = await denied.request('DELETE', `${BASE}/transfers/employees/${s.employeeId}/draft/${stash.id}`, {
      ...as,
      ifMatch: stash.revision,
    });
    expect(cleared.status, await cleared.clone().text()).toBe(403);
    expect(await state(s)).toEqual(before);
    expect(await s.businessState(stash.id)).toBe('draft');
    expect(await s.draft()).toMatchObject({ id: stash.id });
  });

  it.each(CLEAR_REVOKERS)('首次执行：入口放行但命令内已%s → 被拒，暂存单与槽位不变', async (name, apply) => {
    const x = await guardedWorld(`f181a-guard-clear-${name.length}`);
    const stash = await saved(await x.guardedStash(randomUUID()));
    const before = await state(x);
    apply(x.rights);
    const response = await x.guardedClear(stash.id, stash.revision, randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await state(x)).toEqual(before);
    expect(await x.businessState(stash.id)).toBe('draft');
  });

  it.each(CLEAR_REVOKERS)('首次成功后%s：同键同内容重放被拒，业务 / 审计 / 台账不变', async (name, apply) => {
    const x = await guardedWorld(`f181a-guard-clear-replay-${name.length}`);
    const stash = await saved(await x.guardedStash(randomUUID()));
    const key = randomUUID();
    const first = await x.guardedClear(stash.id, stash.revision, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await state(x);
    apply(x.rights);
    const replay = await x.guardedClear(stash.id, stash.revision, key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await state(x)).toEqual(before);
  });

  it.each(CLEAR_REVOKERS)('失败后回查台账：回查前%s → 被拒', async (name, apply) => {
    const x = await guardedWorld(`f181a-guard-clear-recheck-${name.length}`);
    const stash = await saved(await x.guardedStash(randomUUID()));
    const key = randomUUID();
    expect((await x.guardedClear(stash.id, stash.revision, key)).status).toBe(200);
    const before = await state(x);
    hooks.failMainTransaction = true;
    apply(x.rights);
    const replay = await x.guardedClear(stash.id, stash.revision, key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await state(x)).toEqual(before);
  });

  it('对照：权限不变时清除同键重放与失败回查都返回原响应', async () => {
    const x = await guardedWorld('f181a-guard-clear-same');
    const stash = await saved(await x.guardedStash(randomUUID()));
    const key = randomUUID();
    const first = await x.guardedClear(stash.id, stash.revision, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const before = await state(x);
    const replay = await x.guardedClear(stash.id, stash.revision, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    hooks.failMainTransaction = true;
    const recheck = await x.guardedClear(stash.id, stash.revision, key);
    expect(recheck.status).toBe(200);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await state(x)).toEqual(before);
  });
});

describe('F-181a P2-5 元数据读口按字段查看权投影', () => {
  it('只允许看 id / revision：不返回 effectiveDate、异动类型、原因、编制、表单', async () => {
    const x = await guardedWorld('f181a-fields-minimal');
    const stash = await saved(await x.guardedStash(randomUUID()));
    x.rights.fields = new Set(['id', 'revision']);
    const response = await x.guardedRead();
    expect(response.status, await response.clone().text()).toBe(200);
    const { draft } = (await response.json()) as { draft: Record<string, unknown> };
    expect(draft).toEqual({ id: stash.id, revision: stash.revision });
  });

  it('逐字段放开：看到什么字段就返回什么字段', async () => {
    const x = await guardedWorld('f181a-fields-partial');
    await saved(await x.guardedStash(randomUUID()));
    x.rights.fields = new Set(['id', 'revision', 'effectiveDate', 'transferTypeCode']);
    const response = await x.guardedRead();
    const { draft } = (await response.json()) as { draft: Record<string, unknown> };
    expect(Object.keys(draft).sort()).toEqual(['effectiveDate', 'id', 'revision', 'transferTypeCode']);
    expect(draft).toMatchObject({ effectiveDate: D, transferTypeCode: 'cross_department' });
  });

  it('对照：字段全开时返回完整元数据', async () => {
    const x = await guardedWorld('f181a-fields-full');
    const stash = await saved(await x.guardedStash(randomUUID()));
    const response = await x.guardedRead();
    const { draft } = (await response.json()) as { draft: Record<string, unknown> };
    expect(draft).toMatchObject({
      id: stash.id,
      revision: stash.revision,
      effectiveDate: D,
      transferTypeCode: 'cross_department',
      formId: expect.any(String),
      withEstablishment: false,
    });
  });
});
