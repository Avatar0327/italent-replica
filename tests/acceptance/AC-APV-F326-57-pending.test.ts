/**
 * F-326-L AC-57 ①②③（S7a 范围）：继承变量改人只在草稿里记“待生效值”，发布时才写变量（DEC-861⑤）。
 * ④（读视图引用数）属 S7d；⑤⑥⑦ 的测试随 S7e1 补，本文件不覆盖。
 * 流程 A 为“调动”，流程 B 为“个人信息变更”（B 经真实的自助变更申请发起，逐人各一张单）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  audits,
  auditAtRevision,
  autoAt,
  autoRows,
  autoViewOf,
  counter,
  create,
  dispatch,
  draftOk,
  newVersion,
  peopleOf,
  publicVar,
  publishWith,
  s4World,
  specified,
  storedNodes,
  type S4World,
} from './AC-APV-F326-S7a-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });

/** 个人信息变更：每人各提交一张（教育经历自助修改），返回首个待办的办理人。 */
async function changeSubmitter(w: S4World) {
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school'] } },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  return async (person: { userId: string; employeeId: string }) => {
    const path = `/api/tenant/personnel/employees/${person.employeeId}/subsets/education`;
    const record = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
      201,
    );
    const created = await w.request(person.userId, 'POST', '/api/tenant/personnel/change-requests', {
      ifMatch: 0,
      body: {
        employeeId: person.employeeId,
        subset: 'education',
        recordId: record.id,
        targetRevision: record.revision,
        values: { school: `乙校${uniqueSuffix()}` },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const request = (await created.json()) as { id: string };
    const instance = await w.instanceOf(request.id, person.userId);
    return w.pending(instance).map((task) => task.assigneeUserId);
  };
}

async function setup(label: string) {
  const w = await s4World(database().db, label);
  const a2 = await w.person('合成待改选人', w.staff);
  const a = await w.publish(
    await create(w, [single('n1', w.head.userId), single('n2', w.near.userId)], { name: 'A流程' }),
  );
  const x = await autoAt(w, a.id, 'n2');
  const b = await w.publish(
    await create(w, [counter([publicVar(x.id)], { key: 'b1' })], { approvalType: 'personnel_change', name: 'B流程' }),
  );
  const submit = await changeSubmitter(w);
  const people = [await w.person('合成对象甲', w.staff), await w.person('合成对象乙', w.staff)];
  return { w, a, b, a2, x, submit, people };
}

async function approveHead(w: S4World, instanceId: string) {
  const view = await w.detail(instanceId);
  const task = w.pending(view)[0]!;
  const done = await w.taskAction(w.head.userId, task.id, 'approve', view.revision, {});
  expect(done.status, await done.clone().text()).toBe(200);
  return w.pending(await w.detail(instanceId)).map((t) => [t.nodeKey, t.assigneeUserId] as const);
}

describe('AC-APV-F326-L-57 发布时才生效', () => {
  it('① 草稿改人只记待生效值：X 与 revision 不变、无 auto_update；在途与 B 新实例仍派 A1', async () => {
    const { w, a, a2, x, submit, people } = await setup('s7a-pending-1');
    const inflight = await dispatch(w, people[0]!.employeeId);
    const draft = await newVersion(w, a);
    const saved = await draftOk(w, draft, [single('n1', w.head.userId), single('n2', a2.userId)]);

    const row = (await autoRows(w, a.id)).find((item) => item.id === x.id)!;
    expect(peopleOf(row)).toEqual([w.near.userId]);
    expect(row.revision).toBe(x.revision);
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create']);

    const view = autoViewOf(saved.latestVersion.nodes.find((node) => node.key === 'n2')!.approver);
    expect(view).toMatchObject({ id: x.id, userIds: [w.near.userId], pendingUserIds: [a2.userId] });
    const changed = await auditAtRevision(w, saved.id, saved.revision, 'approval.process.draft.update');
    expect(JSON.stringify(changed.after)).toContain(a2.userId);

    expect(await approveHead(w, inflight.instance.id)).toEqual([['n2', w.near.userId]]);
    expect(await submit(people[1]!)).toEqual([w.near.userId]);
  });

  it('② 再保存同样内容 → 无变化；改回 A1 保存 → 待生效值去掉', async () => {
    const { w, a, a2, x } = await setup('s7a-pending-2');
    const draft = await newVersion(w, a);
    const first = await draftOk(w, draft, [single('n1', w.head.userId), single('n2', a2.userId)]);
    const again = await draftOk(w, first, [single('n1', w.head.userId), single('n2', a2.userId)]);
    const sourceOf = (view: typeof first) => autoViewOf(view.latestVersion.nodes.find((n) => n.key === 'n2')!.approver);
    expect(sourceOf(again)).toEqual(sourceOf(first));
    expect(sourceOf(again)!.pendingUserIds).toEqual([a2.userId]);

    const reverted = await draftOk(w, again, [single('n1', w.head.userId), single('n2', w.near.userId)]);
    expect(sourceOf(reverted)!.pendingUserIds).toBeUndefined();
    const row = (await autoRows(w, a.id)).find((item) => item.id === x.id)!;
    expect(row.revision).toBe(x.revision);
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create']);
  });

  it('③ 发布 v2 → 同一事务写 X=A2、auto_update 操作者为发布人；v2 节点无待生效键；之后新实例与激活的节点派 A2', async () => {
    const { w, a, a2, x, submit, people } = await setup('s7a-pending-3');
    const third = await w.person('合成对象丙', w.staff);
    const early = await dispatch(w, people[0]!.employeeId);
    expect(await approveHead(w, early.instance.id)).toEqual([['n2', w.near.userId]]);
    const late = await dispatch(w, people[1]!.employeeId);

    const draft = await newVersion(w, a);
    const saved = await draftOk(w, draft, [single('n1', w.head.userId), single('n2', a2.userId)]);
    const published = await publishWith(w, saved);
    expect(published.status, await published.clone().text()).toBe(200);

    const row = (await autoRows(w, a.id)).find((item) => item.id === x.id)!;
    expect(peopleOf(row)).toEqual([a2.userId]);
    expect(row.revision).toBe(x.revision + 1);
    const trail = await audits(w, x.id);
    expect(actionsOf(trail)).toEqual(['auto_create', 'auto_update']);
    expect(trail[1]).toMatchObject({ actor: w.hr.id });
    expect(trail[1]!.after).toMatchObject({ trigger: { kind: 'publish', versionId: saved.latestVersion.id } });

    const stored = JSON.stringify(await storedNodes(w, saved.latestVersion.id));
    expect(stored).not.toContain('pending');
    expect(await submit(third)).toEqual([a2.userId]);
    // 发布前已派给 A1 的任务不变；另一在途实例此后激活节点 2 → 派给 A2
    expect(w.pending(await w.detail(early.instance.id)).map((t) => t.assigneeUserId)).toEqual([w.near.userId]);
    expect(await approveHead(w, late.instance.id)).toEqual([['n2', a2.userId]]);
  });
});
