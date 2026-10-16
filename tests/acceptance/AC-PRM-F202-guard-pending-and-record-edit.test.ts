/**
 * F-202 命令事务内的授权复核补齐（DEC-406 权限类后补；#372 Sol high 第 1 轮超范围 P2 ×2）：
 * ① 待入职三入口 POST postpone、POST cancel、DELETE /pending-entries/:id；
 * ② 普通任职记录编辑的三条路径：PATCH /records/:id、POST /records/batch-edit、POST /employees/:id/import 的编辑行，
 *    含同一批既有离职记录又有普通记录的混合批次。
 * 首次成功后撤权，同键同内容重放（以及失败后回查台账）必须按当前授权被拒，不再返回台账里的原 200。
 *
 * 撤权模型同 AC-PRM-F195-197-replay-guard：入口（事务外）的复核仍放行，授权提供器只在带事务的调用里应用撤权，
 * 所以旧实现（命令内不复核、重放直接返回台账）按行为失败，而不是因为入口复核恰好拦住而侥幸通过。
 * 被拒时业务、字段级审计、命令台账与 revision 快照都不变。
 * 批量是整单成功或整单失败（AGENTS.md §10）：混合批次里任一条复核不过，整批被拒。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { addPending, businessRevision, entryWorld } from './AC-EN-BE2a-support.js';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';
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
const LAST_WORK_DAY = '2026-10-01';
const rejected = (status: number) => status === 403 || status === 404;

beforeEach(() => {
  hooks.failMainTransaction = false;
});

// ---- ① 待入职三入口 ---------------------------------------------------------------------------------------------

async function pendingWorld(label: string) {
  const w = await entryWorld(database().db, label);
  const { recordId } = await addPending(w, '2026-10-10');
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  return {
    w,
    recordId,
    rights,
    send: (method: string, path: string, key: string, revision: number, body?: object) =>
      api.request(method, `${BASE}/pending-entries/${recordId}${path}`, {
        ...as,
        ifMatch: revision,
        idempotencyKey: key,
        ...(body ? { body } : {}),
      }),
  };
}
type PendingWorld = Awaited<ReturnType<typeof pendingWorld>>;

interface PendingPath {
  readonly name: string;
  readonly call: (x: PendingWorld, key: string, revision: number) => Promise<Response>;
  readonly revokers: readonly Revoker[];
}

const deniesObjectDelete = (request: Request) => request.action === 'object.delete';
const PENDING_PATHS: readonly PendingPath[] = [
  {
    name: 'POST postpone',
    call: (x, key, revision) => x.send('POST', '/postpone', key, revision, { effectiveDate: '2026-10-12' }),
    revokers: [
      ['撤掉任职记录对象编辑权', revoke(deniesObjectUpdate)],
      ['撤掉 Employment.Edit 按钮', revoke(isButton('Employment.Edit'))],
      ['撤掉入职日期字段写权限', revoke(deniesFieldWrite('effectiveDate'))],
      ['数据范围收为空', emptyScope],
    ],
  },
  {
    name: 'POST cancel',
    call: (x, key, revision) => x.send('POST', '/cancel', key, revision, { reason: 'other', remark: '重放复核' }),
    revokers: [
      ['撤掉任职记录对象编辑权', revoke(deniesObjectUpdate)],
      ['撤掉 Employment.Edit 按钮', revoke(isButton('Employment.Edit'))],
      ['数据范围收为空', emptyScope],
    ],
  },
  {
    name: 'DELETE',
    call: (x, key, revision) => x.send('DELETE', '', key, revision),
    revokers: [
      ['撤掉任职记录对象删除权', revoke(deniesObjectDelete)],
      ['撤掉 Employment.Delete 按钮', revoke(isButton('Employment.Delete'))],
      ['数据范围收为空', emptyScope],
    ],
  },
];

async function doneOnce(path: PendingPath, label: string) {
  const x = await pendingWorld(label);
  const revision = await businessRevision(x.w, x.recordId);
  const key = randomUUID();
  const first = await path.call(x, key, revision);
  expect(first.status, await first.clone().text()).toBe(200);
  return { ...x, revision, key, firstBody: (await first.json()) as unknown };
}

describe.each(PENDING_PATHS)('F-202 待入职 $name 同键重放按当前授权复核', (path) => {
  it.each(path.revokers)('首次成功后%s：同键同内容重放被拒，业务 / 审计 / 台账不变', async (name, apply) => {
    const x = await doneOnce(path, `f202-pend-${path.name}-${name.length}`);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    apply(x.rights);
    const replay = await path.call(x, x.key, x.revision);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it.each(path.revokers)('失败后回查台账：回查前%s → 被拒', async (name, apply) => {
    const x = await doneOnce(path, `f202-pend-recheck-${path.name}-${name.length}`);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    hooks.failMainTransaction = true;
    apply(x.rights);
    const replay = await path.call(x, x.key, x.revision);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it('对照：权限不变时同键重放与失败回查都返回原响应，不重复写入', async () => {
    const x = await doneOnce(path, `f202-pend-same-${path.name}`);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    const replay = await path.call(x, x.key, x.revision);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(x.firstBody);
    hooks.failMainTransaction = true;
    const recheck = await path.call(x, x.key, x.revision);
    expect(recheck.status, await recheck.clone().text()).toBe(200);
    expect(await recheck.json()).toEqual(x.firstBody);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it.each(path.revokers)('首次执行：入口放行但命令内已%s → 被拒，无任何写入', async (name, apply) => {
    const x = await pendingWorld(`f202-pend-first-${path.name}-${name.length}`);
    const revision = await businessRevision(x.w, x.recordId);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    apply(x.rights);
    const response = await path.call(x, randomUUID(), revision);
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });
});

// ---- ② 普通任职记录的三条编辑路径 ----------------------------------------------------------------------------------

interface Target {
  readonly id: string;
  readonly employeeId: string;
}

async function recordWorld(label: string) {
  const w = await gateWorld(database().db, label, { today: TODAY });
  const { employee, hire } = await w.hired();
  // 另一名员工在调入部门入职：与第一名员工不在同一数据范围，用来隔离混合批次里“只有普通那条不合格”的情形
  const other = await w.session.employee('调入部门员工');
  const otherHire = await w.session.business(
    other.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { employType: 'internal', departmentId: w.to.id, place: '原地点' },
    },
    other.revision,
  );
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const call = (method: string, path: string, init: { ifMatch?: number; body?: object; key: string }) =>
    api.request(method, `${BASE}${path}`, {
      ...w.as,
      ifMatch: init.ifMatch,
      idempotencyKey: init.key,
      ...(init.body ? { body: init.body } : {}),
    });
  const revisionOf = async (id: string) => {
    const response = await w.session.request('GET', `/businesses/${id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { revision: number }).revision;
  };
  return {
    w,
    rights,
    call,
    revisionOf,
    employee,
    ordinary: { id: hire.id, employeeId: employee.id } satisfies Target,
    otherOrdinary: { id: otherHire.id, employeeId: other.id } satisfies Target,
    /**
     * 同一名员工既有离职记录又有当前有效的普通记录：离职后 10-04 在调出部门重新入职。入职记录被离职取代、不再可编辑，
     * 所以普通那条是重新入职记录；离职记录成为历史，仍按离职口径编辑（同 AC-PRM-F195-197 的重新入职夹具）。
     */
    mixed: async () => {
      const leave = await w.createdLeave(employee.id, leaveBody(LAST_WORK_DAY, 'direct'));
      const { revision } = await w.session.getEmployee(employee.id);
      const rehire = await w.session.business(
        employee.id,
        {
          kind: 'rehire',
          mode: 'direct',
          effectiveDate: '2026-10-04',
          fields: { employType: 'internal', departmentId: w.from.id },
        },
        revision,
      );
      return {
        leave: { id: leave.id, employeeId: employee.id } satisfies Target,
        rehire: { id: rehire.id, employeeId: employee.id } satisfies Target,
      };
    },
  };
}
type RecordWorld = Awaited<ReturnType<typeof recordWorld>>;

const PATCH_BODY = { fields: { place: 'F202重放复核地点' } };

interface Sent {
  readonly send: (key: string) => Promise<Response>;
}
interface RecordPath {
  readonly name: string;
  /** 以给定记录集发起一次该路径的编辑；版本号在首次之前取好，重放带同一份（指纹含前置 revision）。 */
  readonly prepare: (x: RecordWorld, targets: readonly Target[]) => Promise<Sent>;
}

const RECORD_PATHS: readonly RecordPath[] = [
  {
    name: '记录编辑 PATCH /records/:id',
    prepare: async (x, targets) => {
      const [target] = targets;
      const revision = await x.revisionOf(target!.id);
      return {
        send: (key) => x.call('PATCH', `/records/${target!.id}`, { ifMatch: revision, body: PATCH_BODY, key }),
      };
    },
  },
  {
    name: '批量编辑 POST /records/batch-edit',
    prepare: async (x, targets) => {
      const items = await Promise.all(targets.map(async (t) => ({ id: t.id, revision: await x.revisionOf(t.id) })));
      return { send: (key) => x.call('POST', '/records/batch-edit', { key, body: { items, patch: PATCH_BODY } }) };
    },
  },
  {
    name: '导入编辑 POST /employees/:id/import',
    prepare: async (x, targets) => {
      const employeeId = targets[0]!.employeeId;
      const items = await Promise.all(
        targets.map(async (t) => ({
          operation: 'edit',
          id: t.id,
          revision: await x.revisionOf(t.id),
          patch: PATCH_BODY,
        })),
      );
      const { revision } = await x.w.session.getEmployee(employeeId);
      return {
        send: (key) => x.call('POST', `/employees/${employeeId}/import`, { ifMatch: revision, key, body: { items } }),
      };
    },
  },
];

const ORDINARY_REVOKERS: readonly Revoker[] = [
  ['撤掉 Employment.Edit 按钮', revoke(isButton('Employment.Edit'))],
  ['撤掉任职记录对象编辑权', revoke(deniesObjectUpdate)],
  ['撤掉 place 字段写权限', revoke(deniesFieldWrite('place'))],
  ['数据范围收为空', emptyScope],
];

const tenantOf = (x: RecordWorld) => x.w.session.tenant.id;

/** 首次必须成功；返回原响应体（只读一次，后面的对照都与它比较）。 */
async function firstOk(sent: Sent, key: string) {
  const first = await sent.send(key);
  expect(first.status, await first.clone().text()).toBe(200);
  return (await first.json()) as unknown;
}

describe.each(RECORD_PATHS)('F-202 普通记录的$name', (path) => {
  it.each(ORDINARY_REVOKERS)('首次成功后%s：同键同内容重放被拒，业务 / 审计 / 台账不变', async (name, apply) => {
    const x = await recordWorld(`f202-rec-${path.name.length}-${name.length}`);
    const sent = await path.prepare(x, [x.ordinary]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, tenantOf(x));
    apply(x.rights);
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it.each(ORDINARY_REVOKERS)('失败后回查台账：回查前%s → 被拒', async (name, apply) => {
    const x = await recordWorld(`f202-rec-recheck-${path.name.length}-${name.length}`);
    const sent = await path.prepare(x, [x.ordinary]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, tenantOf(x));
    hooks.failMainTransaction = true;
    apply(x.rights);
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it('首次成功后员工范围收窄到不含该记录所在部门：同键重放被拒，业务 / 审计 / 台账不变', async () => {
    const x = await recordWorld(`f202-rec-narrow-${path.name.length}`);
    const sent = await path.prepare(x, [x.ordinary]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, tenantOf(x));
    x.rights.scope = orgScope(tenantOf(x), TODAY, x.w.to.id);
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it('对照：权限与范围都在时，同键重放与失败回查返回原响应，不重复写入', async () => {
    const x = await recordWorld(`f202-rec-same-${path.name.length}`);
    const sent = await path.prepare(x, [x.ordinary]);
    const key = randomUUID();
    const first = await firstOk(sent, key);
    x.rights.scope = orgScope(tenantOf(x), TODAY, x.w.from.id, x.w.to.id);
    const before = await snapshot(x.w.db, tenantOf(x));
    const replay = await sent.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(first);
    hooks.failMainTransaction = true;
    const recheck = await sent.send(key);
    expect(recheck.status, await recheck.clone().text()).toBe(200);
    expect(await recheck.json()).toEqual(first);
    expect(hooks.failMainTransaction, '回查出口必须经过 guard').toBe(false);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it.each(ORDINARY_REVOKERS)('首次执行：入口放行但命令内已%s → 被拒，无任何写入', async (name, apply) => {
    const x = await recordWorld(`f202-rec-first-${path.name.length}-${name.length}`);
    const sent = await path.prepare(x, [x.ordinary]);
    const before = await snapshot(x.w.db, tenantOf(x));
    apply(x.rights);
    const response = await sent.send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });
});

// ---- 混合批次：同一批既有离职记录又有普通记录，逐条复核 ---------------------------------------------------------------

const MIXED_PATHS = RECORD_PATHS.filter((path) => !path.name.startsWith('记录编辑'));

describe.each(MIXED_PATHS)('F-202 混合批次的$name：离职记录 + 普通记录', (path) => {
  it('首次成功后撤掉 Employment.Edit：整批重放被拒（离职那条原本有 guard，普通那条没有）', async () => {
    const x = await recordWorld(`f202-mixed-edit-${path.name.length}`);
    const { leave, rehire } = await x.mixed();
    const sent = await path.prepare(x, [rehire, leave]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, tenantOf(x));
    x.rights.deny = isButton('Employment.Edit');
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it('首次成功后只撤掉 DimissionEdit：离职那条不合格，整批重放被拒', async () => {
    const x = await recordWorld(`f202-mixed-exit-${path.name.length}`);
    const { leave, rehire } = await x.mixed();
    const sent = await path.prepare(x, [rehire, leave]);
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, tenantOf(x));
    x.rights.deny = isButton('Employment.DimissionEdit');
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it('对照：只含普通记录的批次不受 DimissionEdit 撤权影响，同键重放仍返回原响应', async () => {
    const x = await recordWorld(`f202-mixed-ordinary-${path.name.length}`);
    const { rehire } = await x.mixed();
    const sent = await path.prepare(x, [rehire]);
    const key = randomUUID();
    const first = await firstOk(sent, key);
    x.rights.deny = isButton('Employment.DimissionEdit');
    const replay = await sent.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(first);
  });

  it('对照：权限与范围都在时，混合批次同键重放返回原响应', async () => {
    const x = await recordWorld(`f202-mixed-same-${path.name.length}`);
    const { leave, rehire } = await x.mixed();
    const sent = await path.prepare(x, [rehire, leave]);
    const key = randomUUID();
    const first = await firstOk(sent, key);
    const replay = await sent.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(first);
  });
});

describe('F-202 跨员工混合批次 POST /records/batch-edit：只有普通那条不在范围内', () => {
  async function mixedBatch(label: string) {
    const x = await recordWorld(label);
    const { leave } = await x.mixed();
    const sent = await RECORD_PATHS[1]!.prepare(x, [leave, x.otherOrdinary]);
    return { x, sent };
  }

  it('首次成功后范围收窄到只含离职员工所在部门：离职那条仍合格，普通那条在范围外 → 整批重放被拒', async () => {
    const { x, sent } = await mixedBatch('f202-mixed-scope');
    const key = randomUUID();
    await firstOk(sent, key);
    const before = await snapshot(x.w.db, tenantOf(x));
    x.rights.scope = orgScope(tenantOf(x), TODAY, x.w.from.id);
    const replay = await sent.send(key);
    expect(rejected(replay.status), await replay.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it('首次执行：范围只含离职员工所在部门 → 普通那条在范围外，整批被拒，无任何写入', async () => {
    const { x, sent } = await mixedBatch('f202-mixed-scope-first');
    const before = await snapshot(x.w.db, tenantOf(x));
    x.rights.scope = orgScope(tenantOf(x), TODAY, x.w.from.id);
    const response = await sent.send(randomUUID());
    expect(rejected(response.status), await response.clone().text()).toBe(true);
    expect(await snapshot(x.w.db, tenantOf(x))).toEqual(before);
  });

  it('对照：范围含两个部门时，同键重放返回原响应', async () => {
    const { x, sent } = await mixedBatch('f202-mixed-scope-same');
    const key = randomUUID();
    const first = await firstOk(sent, key);
    x.rights.scope = orgScope(tenantOf(x), TODAY, x.w.from.id, x.w.to.id);
    const replay = await sent.send(key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(first);
  });
});
