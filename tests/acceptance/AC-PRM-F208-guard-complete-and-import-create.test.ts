/**
 * F-208 命令事务内的授权复核再补齐（DEC-406 权限类后补；#381 F-202 第 1 轮 Sol high 超范围 P2 ×2）：
 * ① POST /pending-entries/:id/complete 不带合同信息时，命令内复核任职授权（对象编辑权、Employment.Edit、写入口径范围），
 *    带合同时合同 guard 与任职 guard 组合；
 * ② POST /employees/:id/import 的纯新建行（含新建 / 编辑混合批次）在命令内重核 Employment.Create 与当前范围。
 * 首次执行放行入口后撤权被拒，首次成功后撤权的同键重放与失败回查台账也被拒，不再返回台账里的原 200。
 *
 * 撤权模型同 AC-PRM-F202：入口（事务外）的复核仍放行，授权提供器只在带事务的调用里应用撤权，
 * 所以旧实现（命令内不复核）按行为失败，而不是因为入口复核恰好拦住而侥幸通过。
 * 被拒时业务、字段级审计、命令台账与 revision 快照都不变；批量整单成功或整单失败（AGENTS.md §10）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { addPending, businessRevision, entryWorld } from './AC-EN-BE2a-support.js';
import { gateWorld } from './AC-EXIT-gate-support.js';
import {
  deniesFieldWrite,
  deniesObjectUpdate,
  emptyScope,
  isButton,
  orgScope,
  revocable,
  revoke,
  snapshot,
  type Request,
  type Revoker,
} from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';

// 失败后回查：让命令主事务的 guard.before 第一次抛错（模拟并发冲突回滚），runCommand 随后走 replayAfterFailure 的回查出口。
// 路径上没有 guard 时原样透传，hooks.failMainTransaction 保持为真——用例据此证明“回查出口确实经过了 guard”。
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
const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
const rejected = (status: number) => status === 403 || status === 404;
const deniesObjectCreate = (request: Request) => request.action === 'object.create';

beforeEach(() => {
  hooks.failMainTransaction = false;
});

// ---- ① 办理入职不带合同 -------------------------------------------------------------------------------------------

async function completeWorld(label: string) {
  const w = await entryWorld(database().db, label);
  const { recordId } = await addPending(w, '2026-10-01');
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  const revision = await businessRevision(w, recordId);
  return {
    w,
    rights,
    send: (key: string) =>
      api.request('POST', `${BASE}/pending-entries/${recordId}/complete`, {
        ...as,
        ifMatch: revision,
        idempotencyKey: key,
        body: { probation: false },
      }),
  };
}
type CompleteWorld = Awaited<ReturnType<typeof completeWorld>>;

const COMPLETE_REVOKERS: readonly Revoker[] = [
  ['撤掉任职记录对象编辑权', revoke(deniesObjectUpdate)],
  ['撤掉 Employment.Edit 按钮', revoke(isButton('Employment.Edit'))],
  ['数据范围收为空', emptyScope],
];

const tenantOfComplete = (x: CompleteWorld) => x.w.session.tenant.id;

describe('F-208 DEC-406 办理入职不带合同信息：命令内复核任职授权', () => {
  it.each(COMPLETE_REVOKERS)('首次执行：入口放行但命令内已%s → 被拒，无任何写入', async (name, apply) => {
    const x = await completeWorld(`f208-complete-first-${name.length}`);
    const before = await snapshot(x.w.db, tenantOfComplete(x));
    apply(x.rights);
    const response = await x.send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOfComplete(x))).toEqual(before);
  });

  it.each(COMPLETE_REVOKERS)('首次成功后%s：同键同内容重放被拒，业务 / 审计 / 台账不变', async (name, apply) => {
    const x = await completeWorld(`f208-complete-replay-${name.length}`);
    const key = randomUUID();
    const first = await x.send(key);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await snapshot(x.w.db, tenantOfComplete(x));
    apply(x.rights);
    const replay = await x.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOfComplete(x))).toEqual(before);
  });

  it.each(COMPLETE_REVOKERS)('失败后回查台账：回查前%s → 被拒', async (name, apply) => {
    const x = await completeWorld(`f208-complete-recheck-${name.length}`);
    const key = randomUUID();
    const first = await x.send(key);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await snapshot(x.w.db, tenantOfComplete(x));
    hooks.failMainTransaction = true;
    apply(x.rights);
    const replay = await x.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, tenantOfComplete(x))).toEqual(before);
  });

  it('对照：权限与范围都在时，首次成功，同键重放与失败回查返回原响应，不重复写入', async () => {
    const x = await completeWorld('f208-complete-same');
    const key = randomUUID();
    const first = await x.send(key);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const before = await snapshot(x.w.db, tenantOfComplete(x));
    const replay = await x.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    hooks.failMainTransaction = true;
    const recheck = await x.send(key);
    expect(recheck.status, await recheck.clone().text()).toBe(200);
    expect(await recheck.json()).toEqual(firstBody);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, tenantOfComplete(x))).toEqual(before);
  });
});

// ---- ① 办理入职带合同信息：任职 guard 与合同 guard 组合，合同权限的既有复核不变 ----------------------------------------

async function contractCompleteWorld(label: string) {
  const w = await entryWorld(database().db, label);
  const { recordId } = await addPending(w, '2026-10-01');
  const open = tenantApi(w.db, { clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await open.request('POST', `/api/tenant/contracts/master-data/${kind}`, {
      ...as,
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const typeId = await master('types', '劳动合同');
  const companyId = await master('companies', '合成法人公司');
  const contract = { typeId, companyId, termType: 'fixed', termMonths: 12, endDate: '2027-08-31' };
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const revision = await businessRevision(w, recordId);
  return {
    w,
    rights,
    send: (key: string) =>
      api.request('POST', `${BASE}/pending-entries/${recordId}/complete`, {
        ...as,
        ifMatch: revision,
        idempotencyKey: key,
        body: { probation: false, contract },
      }),
  };
}

describe('F-208 DEC-406 办理入职带合同信息：任职授权与合同授权都在命令内复核', () => {
  const REVOKERS: readonly Revoker[] = [
    ['撤掉 Employment.Edit 按钮', revoke(isButton('Employment.Edit'))],
    ['数据范围收为空', emptyScope],
  ];

  it.each(REVOKERS)('首次执行：入口放行但命令内已%s → 被拒，无任何写入', async (name, apply) => {
    const x = await contractCompleteWorld(`f208-ct-first-${name.length}`);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    apply(x.rights);
    const response = await x.send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it.each(REVOKERS)('首次成功后%s：同键重放与失败回查都被拒', async (name, apply) => {
    const x = await contractCompleteWorld(`f208-ct-replay-${name.length}`);
    const key = randomUUID();
    const first = await x.send(key);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    apply(x.rights);
    const replay = await x.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    hooks.failMainTransaction = true;
    const recheck = await x.send(key);
    expect(rejected(recheck.status), await recheck.clone().text()).toBe(true);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it('对照：权限与范围都在时，同键重放与失败回查返回原响应', async () => {
    const x = await contractCompleteWorld('f208-ct-same');
    const key = randomUUID();
    const first = await x.send(key);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const replay = await x.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    hooks.failMainTransaction = true;
    const recheck = await x.send(key);
    expect(recheck.status, await recheck.clone().text()).toBe(200);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
  });
});

// ---- ② 导入新建行 -----------------------------------------------------------------------------------------------

async function importWorld(label: string) {
  const w = await gateWorld(database().db, label, { today: TODAY });
  const { employee, hire } = await w.hired();
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const tenant = w.session.tenant.id;
  const employeeRevision = async () => (await w.session.getEmployee(employee.id)).revision;
  const revisionOf = async (id: string) => {
    const response = await w.session.request('GET', `/businesses/${id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { revision: number }).revision;
  };
  /** 新建行：转正（非调动，不走调动发起权限的既有复核，只靠新增的创建 guard）；departmentId 给出时显式落在该部门。 */
  const createItem = (effectiveDate: string, departmentId?: string) => ({
    operation: 'create',
    business: {
      kind: 'regularization',
      mode: 'direct',
      effectiveDate,
      fields: { remarks: 'F208导入新建', ...(departmentId ? { departmentId } : {}) },
    },
  });
  const editItem = async () => ({
    operation: 'edit',
    id: hire.id,
    revision: await revisionOf(hire.id),
    patch: { fields: { place: 'F208导入编辑地点' } },
  });
  const sendItems = async (items: readonly object[]) => {
    const ifMatch = await employeeRevision();
    return {
      send: (key: string) =>
        api.request('POST', `${BASE}/employees/${employee.id}/import`, {
          ...w.as,
          ifMatch,
          idempotencyKey: key,
          body: { items },
        }),
    };
  };
  return { w, rights, tenant, createItem, editItem, sendItems };
}
type ImportWorld = Awaited<ReturnType<typeof importWorld>>;
type Sent = Awaited<ReturnType<ImportWorld['sendItems']>>;

const CREATE_REVOKERS: readonly Revoker[] = [
  ['撤掉 Employment.Create 按钮', revoke(isButton('Employment.Create'))],
  ['撤掉任职记录对象新增权', revoke(deniesObjectCreate)],
  ['撤掉 remarks 字段写权限', revoke(deniesFieldWrite('remarks'))],
  ['数据范围收为空', emptyScope],
];

async function firstOk(sent: Sent, key: string) {
  const first = await sent.send(key);
  expect(first.status, await first.clone().text()).toBe(200);
  return (await first.json()) as unknown;
}

describe('F-208 DEC-406 导入纯新建批次：命令内重核创建授权', () => {
  it.each(CREATE_REVOKERS)('首次执行：入口放行但命令内已%s → 被拒，无任何写入', async (name, apply) => {
    const x = await importWorld(`f208-imp-first-${name.length}`);
    const sent = await x.sendItems([x.createItem('2026-09-20')]);
    const before = await snapshot(x.w.db, x.tenant);
    apply(x.rights);
    const response = await sent.send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.tenant)).toEqual(before);
  });

  it.each(CREATE_REVOKERS)('首次成功后%s：同键同内容重放被拒，业务 / 审计 / 台账不变', async (name, apply) => {
    const x = await importWorld(`f208-imp-replay-${name.length}`);
    const sent = await x.sendItems([x.createItem('2026-09-20')]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, x.tenant);
    apply(x.rights);
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.tenant)).toEqual(before);
  });

  it.each(CREATE_REVOKERS)('失败后回查台账：回查前%s → 被拒', async (name, apply) => {
    const x = await importWorld(`f208-imp-recheck-${name.length}`);
    const sent = await x.sendItems([x.createItem('2026-09-20')]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, x.tenant);
    hooks.failMainTransaction = true;
    apply(x.rights);
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, x.tenant)).toEqual(before);
  });

  it('首次执行：新建行显式落在范围外的部门（员工当前部门仍在范围内）→ 被拒，无任何写入', async () => {
    const x = await importWorld('f208-imp-dept-first');
    const sent = await x.sendItems([x.createItem('2026-09-20', x.w.to.id)]);
    const before = await snapshot(x.w.db, x.tenant);
    x.rights.scope = orgScope(x.tenant, TODAY, x.w.from.id);
    const response = await sent.send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.tenant)).toEqual(before);
  });

  it('对照：范围覆盖员工与目标部门时首次成功，同键重放与失败回查返回原响应', async () => {
    const x = await importWorld('f208-imp-same');
    const sent = await x.sendItems([x.createItem('2026-09-20', x.w.to.id)]);
    x.rights.scope = orgScope(x.tenant, TODAY, x.w.from.id, x.w.to.id);
    const key = randomUUID();
    const first = await firstOk(sent, key);
    const before = await snapshot(x.w.db, x.tenant);
    const replay = await sent.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(first);
    hooks.failMainTransaction = true;
    const recheck = await sent.send(key);
    expect(recheck.status, await recheck.clone().text()).toBe(200);
    expect(await recheck.json()).toEqual(first);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, x.tenant)).toEqual(before);
  });
});

describe('F-208 DEC-406 导入新建 / 编辑混合批次：逐行复核，任一行不过整批被拒', () => {
  const MIXED: readonly Revoker[] = [
    ['只撤掉 Employment.Create（编辑行仍合格）', revoke(isButton('Employment.Create'))],
    ['只撤掉 Employment.Edit（新建行仍合格）', revoke(isButton('Employment.Edit'))],
  ];

  it.each(MIXED)('首次执行：%s → 整批被拒，无任何写入', async (name, apply) => {
    const x = await importWorld(`f208-mixed-first-${name.length}`);
    const sent = await x.sendItems([x.createItem('2026-09-20'), await x.editItem()]);
    const before = await snapshot(x.w.db, x.tenant);
    apply(x.rights);
    const response = await sent.send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.tenant)).toEqual(before);
  });

  it.each(MIXED)('首次成功后%s：整批重放被拒', async (name, apply) => {
    const x = await importWorld(`f208-mixed-replay-${name.length}`);
    const sent = await x.sendItems([x.createItem('2026-09-20'), await x.editItem()]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, x.tenant);
    apply(x.rights);
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.tenant)).toEqual(before);
  });

  it('对照：权限与范围都在时，混合批次同键重放返回原响应', async () => {
    const x = await importWorld('f208-mixed-same');
    const sent = await x.sendItems([x.createItem('2026-09-20'), await x.editItem()]);
    const key = randomUUID();
    const first = await firstOk(sent, key);
    const replay = await sent.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(first);
  });

  it('对照：纯编辑批次不受 Employment.Create 撤权影响，同键重放仍返回原响应（F-202 口径不变）', async () => {
    const x = await importWorld('f208-edit-only');
    const sent = await x.sendItems([await x.editItem()]);
    const key = randomUUID();
    const first = await firstOk(sent, key);
    x.rights.deny = isButton('Employment.Create');
    const replay = await sent.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(first);
  });
});
