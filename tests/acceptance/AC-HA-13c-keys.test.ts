import './support/exit-gate-enforced.js';
/**
 * AC-HA-13c 人事流程看板（规格 35 B51，R2 BE-13c 第 2 轮返工）：分组 / 筛选键的回归。
 * - 批量 Offer 的流程所属部门 = 单内各 Offer 的录用部门：同部门批量单筛该部门可见；跨部门批量单筛其中任一部门都可见；
 *   数据范围要求单内每一份 Offer 都在范围内（同审批中心 access.ts offerInstanceScopeSql）；
 * - 节点身份含流程版本：不同流程里同名的节点键分别统计，概览与钻取共用同一个组键；
 * - 退回（没有待办）的在途流程，等待分档为空，不落进“≤3 天”；
 * - 7.1.23 转正正例：直接转正计入业务总量、不计审批总量；走流程且审批通过的两者都计；审批中的转正不算业务总量；
 * - 7.1.20 Offer 业务总量（第 3 轮）：免审批 + 审批通过计入；驳回待重提、撤回、批量单驳回后回到“未发起审批”的不计。
 * - 7.1.20 第 4 轮：关联过实例、未在审批中通过，但之后免审批发送 / 转已接受（已脱离待发）的，算业务总量、不算审批总量。
 * 期望值一律是手写的实例 / 任务 / 业务单据 ID 集合。
 */
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import type { InstanceView, Person } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { offerApprovalWorld, type OfferView } from './AC-OF-BE14a3-support.js';
import { hire, pbWorld, regularizeOk } from './AC-PB-support.js';
import { processClient, sorted, type ProcessClient } from './AC-HA-13c-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const AS_OF = '2026-10-20';
const at = (date: string, hour = '01') => `${date}T${hour}:00:00.000Z`;

type World = Awaited<ReturnType<typeof offerApprovalWorld>>;

async function buildWorld(w: World) {
  w.setNow(at('2026-09-01'));
  const x = await w.org('一级组织X');
  const boss = await w.person('直线经理', x);
  const subject = (name: string) => w.person(name, x, { directManagerId: boss.employeeId });
  const s = {
    a: await subject('调动甲'),
    b: await subject('调动乙'),
    c: await subject('离职丙'),
    r: await subject('退回丁'),
  };
  await installExitSeeds(w.db, w.tenant.id);
  // 两个流程都用节点键 mgr，名称不同
  await w.publishedProcess({ nodes: [{ key: 'mgr', name: '直线经理审批', approver: 'direct_manager' }] });
  await w.publishedProcess({
    approvalType: 'leave',
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
    nodes: [{ key: 'mgr', name: '离职审批节点', approver: 'direct_manager' }],
  });

  async function approve(view: InstanceView, doneAt: string) {
    const task = w.pending(view)[0]!;
    expect(task.assigneeUserId).toBe(boss.userId);
    w.setNow(doneAt);
    const done = await w.json<InstanceView>(await w.taskAction(boss.userId, task.id, 'approve', view.revision));
    expect(done.status).toBe('approved');
    return { instance: view.id, task: task.id };
  }
  async function transfer(person: Person, submitAt: string) {
    w.setNow(submitAt);
    const business = await w.application(person.employeeId, { departmentId: x }, { effectiveDate: '2026-10-30' });
    return w.submit(business);
  }
  const a = await approve(await transfer(s.a, at('2026-10-05')), at('2026-10-06'));
  const b = await approve(await transfer(s.b, at('2026-10-06')), at('2026-10-07'));

  // 离职申请走 mgr 节点（离职流程）
  w.setNow(at('2026-10-08'));
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.c.employeeId}`),
  );
  const leave = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.c.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'leave',
        mode: 'application',
        lastWorkDate: '2026-10-30',
        fields: {},
        exit: { exitTypeCode: 'voluntary' },
      },
    }),
    201,
  );
  const exit = await approve(await w.submit(leave), at('2026-10-09'));

  // 退回：调动被直线经理驳回到发起人，实例在途但没有待办
  const returnedView = await transfer(s.r, at('2026-10-10'));
  w.setNow(at('2026-10-11'));
  const rejected = await w.json<InstanceView>(
    await w.taskAction(boss.userId, w.pending(returnedView)[0]!.id, 'reject', returnedView.revision, {
      comment: '合成驳回意见',
    }),
  );
  expect(rejected.status).toBe('returned');

  // 批量 Offer：同部门两份（录用部门 D1）；跨部门一份 D1 + 一份 D2
  w.setNow(at('2026-10-12'));
  const d2 = await w.org('另一录用部门');
  const d2Head = await w.person('另一部门负责人', d2);
  await w.setOrgRoles(d2, { head: d2Head.employeeId });
  const p = await w.offer(w.applicant);
  const q = await w.offer(w.applicant);
  const r = await w.offer(w.applicant);
  const t = await w.offer(w.applicant, d2);
  const same = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [p.id, q.id] }), 201);
  const cross = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [r.id, t.id] }), 201);
  const sameInstance = (await w.instance(same.id)).id;
  const crossInstance = (await w.instance(cross.id)).id;

  w.setNow(at(AS_OF));
  return {
    x,
    d1: w.department,
    d2,
    transfers: [a, b],
    exit,
    returned: returnedView.id,
    batches: { same: sameInstance, cross: crossInstance },
  };
}

let w: World;
let f: Awaited<ReturnType<typeof buildWorld>>;
let board: ProcessClient;

beforeAll(async () => {
  w = await offerApprovalWorld(database().db, 'ha13c-keys');
  f = await buildWorld(w);
  board = processClient(w.db, { tenant: w.tenant.id, user: w.hr.id }, { now: () => new Date(at(AS_OF)) });
}, 600_000);

const management = (orgIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  orgIds,
  terms: [
    {
      dimension: 'management',
      orgIds,
      personIds: [],
      personQuery: { kind: 'organization', tenantId: w.tenant.id, asOf: AS_OF },
    },
  ],
});
const scoped = (scope: ModuleScope) => {
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async () => scope,
    authorize: async (request) => authorize(request),
    fields: async () => new Set(),
  });
  return processClient(w.db, { tenant: w.tenant.id, user: w.hr.id }, { now: () => new Date(at(AS_OF)), authorize });
};

describe('AC-HA-13c 批量 Offer 的流程所属部门', () => {
  const offerQuery = (department?: string) =>
    ['category=offer', department && `departmentId=${department}`].filter(Boolean).join('&');

  it('看全部：同部门批量单不筛部门、筛该部门都可见，数字 = 明细', async () => {
    const both = [f.batches.same, f.batches.cross];
    await board.expectComponent('inFlightCount', { all: both, hits: both }, offerQuery());
    await board.expectComponent('inFlightCount', { all: both, hits: both }, offerQuery(f.d1));
    const list = await board.detail('inFlightList', offerQuery(f.d1));
    expect(list.find((item) => item.id === f.batches.same)?.departmentId).toBe(f.d1);
  });

  it('跨部门批量单：筛其中任一录用部门都可见（不丢单），明细的部门为空（不归属单一部门）', async () => {
    await board.expectComponent('inFlightCount', { all: [f.batches.cross], hits: [f.batches.cross] }, offerQuery(f.d2));
    const list = await board.detail('inFlightList', offerQuery(f.d2));
    expect(list.map((item) => [item.id, item.departmentId])).toEqual([[f.batches.cross, null]]);
  });

  it('数据范围：单内每一份 Offer 的录用部门都在范围内才可见（一份范围外即整单不可见）', async () => {
    const d1Only = scoped(management([f.d1]));
    await d1Only.expectComponent('inFlightCount', { all: [f.batches.same], hits: [f.batches.same] }, offerQuery());
    await d1Only.expectComponent('inFlightCount', { all: [f.batches.same], hits: [f.batches.same] }, offerQuery(f.d1));
    const d2Only = scoped(management([f.d2]));
    await d2Only.expectComponent('inFlightCount', { all: [], hits: [] }, offerQuery(f.d2));
  });
});

describe('AC-HA-13c 节点身份含流程版本', () => {
  it('7.2.08 不同流程的同名节点键分别统计（调动 2、离职 1），钻取明细与组计数一致', async () => {
    const row = await board.component('taskDurationByNode');
    const groups = row.groups.map((g) => [g.label, g.count]);
    expect(sorted(groups.map((g) => JSON.stringify(g)))).toEqual(
      sorted([JSON.stringify(['直线经理审批', 2]), JSON.stringify(['离职审批节点', 1])]),
    );
    const keyOf = (label: string) => row.groups.find((g) => g.label === label)!.key;
    const transfer = await board.expectGroup(
      'taskDurationByNode',
      { group: keyOf('直线经理审批') },
      f.transfers.map((flow) => flow.task),
    );
    const exit = await board.expectGroup('taskDurationByNode', { group: keyOf('离职审批节点') }, [f.exit.task]);
    expect(transfer?.key).not.toBe(exit?.key);
  });
});

describe('AC-HA-13c 退回的在途流程', () => {
  it('7.2.05 退回（没有待办）：在途，等待分档为空，不计入等待超过 3 天', async () => {
    const list = await board.detail('inFlightList', 'category=transfer');
    expect(list.map((item) => [item.id, item.currentApproverUserId, item.waitBucket])).toEqual([
      [f.returned, null, null],
    ]);
    await board.expectComponent('inFlightWaiting', { all: [], hits: [] }, 'category=transfer');
  });
});

describe('AC-HA-13c 7.1.23 转正正例', () => {
  it('直接转正计入业务总量、不计审批总量；走流程且审批通过的计入两者；审批中的转正申请不算业务总量', async () => {
    const pb = await pbWorld(database().db, 'ha13c-regular-rate', { approval: true });
    const direct = await hire(pb, { months: 3, name: '直接转正' });
    const pending = await hire(pb, { months: 3, name: '转正审批中' });
    const passed = await hire(pb, { months: 3, name: '转正审批通过' });
    const done = await regularizeOk(pb, { mode: 'direct' }, [direct.employee.id]);
    const review = await regularizeOk(pb, { mode: 'application' }, [pending.employee.id]);
    expect(review.items[0]).toMatchObject({ status: 'succeeded', businessStatus: 'in_review' });
    const approved = (await regularizeOk(pb, { mode: 'application' }, [passed.employee.id])).items[0]!.businessId!;
    const now = new Date('2026-10-01T01:00:00.000Z');
    const api = tenantApi(pb.db, { clock: () => now });
    const as = (user: string) => ({ user, tenant: pb.session.tenant.id });
    const read = async <T>(path: string) =>
      (await (await api.request('GET', `/api/tenant/approval${path}`, as(pb.session.user.id))).json()) as T;
    const [listed] = (await read<{ items: { id: string }[] }>(`/instances?role=initiated&businessId=${approved}`))
      .items;
    const view = await read<InstanceView>(`/instances/${listed!.id}`);
    const task = view.tasks.find((t) => t.status === 'pending')!;
    const response = await api.request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ...as(task.assigneeUserId),
      ifMatch: view.revision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const regular = processClient(
      pb.db,
      { tenant: pb.session.tenant.id, user: pb.session.user.id },
      { now: () => now },
    );
    const row = await regular.expectComponent('regularizationApprovalRate', {
      all: [done.items[0]!.businessId!, approved],
      hits: [approved],
    });
    expect(row.rate).toBe(0.5);
  });
});

describe('AC-HA-13c 7.1.20 Offer 业务总量（第 3 轮）', () => {
  it('免审批 + 审批通过计入；驳回待重提、撤回、批量单驳回后回到“未发起审批”的不计', async () => {
    const o = await offerApprovalWorld(database().db, 'ha13c-offer-rate');
    o.setNow(at('2026-10-05'));
    const free = await o.offer(o.applicant);
    const passed = await o.offer(o.applicant);
    await o.json(await o.submitRaw(passed));
    await o.decide(await o.instance(passed.id), o.head, 'approve');
    const rejected = await o.offer(o.applicant);
    await o.json(await o.submitRaw(rejected));
    const rejectedView = await o.instance(rejected.id);
    await o.decide(rejectedView, o.head, 'reject');
    expect((await o.instance(rejected.id)).status).toBe('returned');
    const withdrawn = await o.offer(o.applicant);
    await o.json(await o.submitRaw(withdrawn));
    const withdrawnView = await o.instance(withdrawn.id);
    await o.json(await o.instanceAction(o.applicant.userId, withdrawnView.id, 'withdraw', withdrawnView.revision));
    const batched = await o.offer(o.applicant);
    const batch = await o.json<{ id: string }>(await o.batchRaw({ offerIds: [batched.id] }), 201);
    await o.decide(await o.instance(batch.id), o.manager, 'reject');
    for (const offer of [rejected, withdrawn, batched]) {
      expect((await o.get(offer.id)).approvalStatus).toBe('unsubmitted');
    }

    const rate = processClient(o.db, { tenant: o.tenant.id, user: o.hr.id }, { now: () => new Date(at(AS_OF)) });
    const row = await rate.expectComponent('offerApprovalRate', { all: [free.id, passed.id], hits: [passed.id] });
    expect(row.rate).toBe(0.5);
    expect(sorted((await rate.detail('offerApprovalRate')).map((item) => item.id))).toEqual(
      sorted([free.id, passed.id]),
    );
  });
  it('关联过实例、未在审批中通过，但已免审批发送 / 转已接受的计入业务总量、不计审批总量（第 4 轮）', async () => {
    const o = await offerApprovalWorld(database().db, 'ha13c-offer-life');
    o.setNow(at('2026-10-05'));
    const write = async (offer: OfferView, action: string, body: Record<string, unknown>) =>
      o.json<OfferView>(
        await o.request(o.applicant.userId, 'POST', `/api/tenant/offers/${offer.id}/${action}`, {
          ifMatch: offer.revision,
          body,
        }),
      );
    const accept = { target: 'accepted', acceptTime: '2026-10-05' };
    const refuse = { target: 'rejected', refusalTime: '2026-10-05', refusalReasonCode: 'personal' };
    const passed = await o.offer(o.applicant);
    await o.json(await o.submitRaw(passed));
    await o.decide(await o.instance(passed.id), o.head, 'approve');
    // ① 审批通过 → 发送 → 已拒绝 → 退回待发（审批子状态重置为未发起，rules.ts 已拒绝 → 待发）→ 免审批再次发送
    const resent = await o.offer(o.applicant);
    await o.json(await o.submitRaw(resent));
    await o.decide(await o.instance(resent.id), o.head, 'approve');
    const back = await write(
      await write(await write(await o.get(resent.id), 'send', {}), 'transfer', refuse),
      'transfer',
      {
        target: 'pending',
      },
    );
    expect(back.approvalStatus).toBe('unsubmitted');
    await write(back, 'send', {});
    // ② 撤回后直接转已接受
    const withdrawn = await o.offer(o.applicant);
    await o.json(await o.submitRaw(withdrawn));
    const withdrawnView = await o.instance(withdrawn.id);
    await o.json(await o.instanceAction(o.applicant.userId, withdrawnView.id, 'withdraw', withdrawnView.revision));
    await write(await o.get(withdrawn.id), 'transfer', accept);
    // ③ 驳回后直接转已接受
    const rejected = await o.offer(o.applicant);
    await o.json(await o.submitRaw(rejected));
    await o.decide(await o.instance(rejected.id), o.head, 'reject');
    await write(await o.get(rejected.id), 'transfer', accept);
    // ④ 同类（DEC-431①）：否决后免审批直接发送
    const disagreed = await o.offer(o.applicant);
    await o.json(await o.submitRaw(disagreed));
    await o.decide(await o.instance(disagreed.id), o.head, 'disagree');
    expect((await o.get(disagreed.id)).approvalStatus).toBe('disapproved');
    await write(await o.get(disagreed.id), 'send', {});
    // 对照：驳回后仍待发（待重提）、否决后仍待发，都不计
    const waiting = await o.offer(o.applicant);
    await o.json(await o.submitRaw(waiting));
    await o.decide(await o.instance(waiting.id), o.head, 'reject');
    const vetoed = await o.offer(o.applicant);
    await o.json(await o.submitRaw(vetoed));
    await o.decide(await o.instance(vetoed.id), o.head, 'disagree');
    const states = [resent, withdrawn, rejected, disagreed, waiting, vetoed].map(async (offer) => {
      const view = await o.get(offer.id);
      return [view.status, view.approvalStatus];
    });
    expect(await Promise.all(states)).toEqual([
      ['sent', 'unsubmitted'],
      ['accepted', 'unsubmitted'],
      ['accepted', 'unsubmitted'],
      ['sent', 'disapproved'],
      ['pending', 'unsubmitted'],
      ['pending', 'disapproved'],
    ]);

    const rate = processClient(o.db, { tenant: o.tenant.id, user: o.hr.id }, { now: () => new Date(at(AS_OF)) });
    const counted = [passed.id, resent.id, withdrawn.id, rejected.id, disagreed.id];
    const row = await rate.expectComponent('offerApprovalRate', { all: counted, hits: [passed.id] });
    expect(row.rate).toBe(0.2);
    expect(sorted((await rate.detail('offerApprovalRate')).map((item) => item.id))).toEqual(sorted(counted));
  });
});
