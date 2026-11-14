/**
 * F-326-S7a 第 2 轮返工（审查 rf326s7a_1）：全部走真实 HTTP，读回的变量 / 审计 / 视图都是服务端真实写出的行。
 * P2-2 保存收尾的第三类候选（手工重新启用过、来源版本更早）；P2-3 发布冲突的重选协议；
 * P2-4 pendingConflict 与发布同一判定；P2-6 草稿期限制按位置（节点 × 位置）；P2-7 人数上限；P3 审计归位。
 * P2-1（锁升级死锁）需要真 PostgreSQL 并发，见 AC-APV-F326-S7a-lock-pg.test.ts。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  audits,
  autoAt,
  autoRows,
  autoViewOf,
  counter,
  create,
  draftOk,
  editVariable,
  manager,
  newVersion,
  peopleOf,
  placeholder,
  publicVar,
  publishWith,
  readProcess,
  s4World,
  saveDraft,
  specified,
  variableCount,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { references, rejected, variableCommand } from './AC-APV-F326-S4-support.js';

const database = useTestDb();
const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });
const viaManager = (key: string): NodeInput => ({ key, name: `节点${key}`, approver: manager });

/** 流程 A 已发布（n2 = near，自动变量 X）；草稿 v2 把 n2 改成 a2（继承变量 → 待生效值）。 */
async function pendingWorld(label: string) {
  const w = await s4World(database().db, label);
  const a2 = await w.person('合成待改选人', w.staff);
  const other = await w.person('合成变量页改的人', w.staff);
  const a = await w.publish(await create(w, [single('n1', w.head.userId), single('n2', w.near.userId)]));
  const x = await autoAt(w, a.id, 'n2');
  const draft = await newVersion(w, a);
  const saved = await draftOk(w, draft, [single('n1', w.head.userId), single('n2', a2.userId)]);
  return { w, a, a2, other, x, saved };
}
const nodeAutoView = (view: Awaited<ReturnType<typeof readProcess>>, key: string) =>
  autoViewOf(view.latestVersion.nodes.find((node) => node.key === key)!.approver);

describe('AC-APV-F326-S7a-r2 P2-2 保存收尾含“手工重新启用过”的本流程自动变量（来源版本更早）', () => {
  it('X 属 v1；管理员停用再启用；v3 草稿保存（不引用 X）→ X 被 auto_disable，操作人为保存人，reason“不再被引用”', async () => {
    const w = await s4World(database().db, 's7a-r2-reenable');
    const v1 = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const x = await autoAt(w, v1.id, 'n1');
    const v2 = await w.json<Awaited<ReturnType<typeof create>>>(
      await publishWith(w, await draftOk(w, await newVersion(w, v1), [viaManager('n1')])),
    );
    const { total } = await references(w, 'variables', x.id);
    const off = await variableCommand(w, await varRow(w, x.id), 'disable', { acknowledgedReferenceCount: total });
    expect(off.status, await off.clone().text()).toBe(200);
    const on = await variableCommand(w, await varRow(w, x.id), 'enable');
    expect(on.status, await on.clone().text()).toBe(200);
    expect((await varRow(w, x.id)).status).toBe('enabled');

    await draftOk(w, await newVersion(w, v2), [viaManager('n1')]);

    expect((await varRow(w, x.id)).status).toBe('disabled');
    const last = (await audits(w, x.id)).at(-1)!;
    expect(last.action).toBe('approval.public_variable.auto_disable');
    expect(last.actor).toBe(w.hr.id);
    expect(last.after).toMatchObject({ reason: '不再被引用' });
  });
});

describe('AC-APV-F326-S7a-r2 P2-3 发布冲突的重选协议', () => {
  it('选择带的 revision 已过期 → 409 且 details.conflicts 带最新两边值（可直接重选）', async () => {
    const { w, a2, other, x, saved } = await pendingWorld('s7a-r2-stale');
    const third = await w.person('合成再次改的人', w.staff);
    const first = await editVariable(w, x, { defaultValue: other.userId });
    expect(first.status, await first.clone().text()).toBe(200);
    const mid = await varRow(w, x.id);
    const second = await editVariable(w, mid, { defaultValue: third.userId });
    expect(second.status, await second.clone().text()).toBe(200);
    const latest = await varRow(w, x.id);

    const error = await rejected(
      await publishWith(w, saved, {
        pendingResolutions: [{ variableId: x.id, revision: mid.revision, choice: 'designer' }],
      }),
      409,
      'APPROVAL_PENDING_VARIABLE_CONFLICT',
    );
    expect(error.code).toBe('CONFLICT');
    expect((error.details as { conflicts?: unknown[] }).conflicts).toEqual([
      expect.objectContaining({
        variableId: x.id,
        revision: latest.revision,
        designerUserIds: [a2.userId],
        currentUserIds: [third.userId],
      }),
    ]);
    // 整个事务回滚：变量与草稿都不变
    expect(await varRow(w, x.id)).toEqual(latest);
    const again = await publishWith(w, saved, {
      pendingResolutions: [{ variableId: x.id, revision: latest.revision, choice: 'designer' }],
    });
    expect(again.status, await again.clone().text()).toBe(200);
    expect(peopleOf(await varRow(w, x.id))).toEqual([a2.userId]);
  });

  it('同一变量重复选择 → 400 APPROVAL_PENDING_RESOLUTION_INVALID，不写任何变量', async () => {
    const { w, other, x, saved } = await pendingWorld('s7a-r2-dup');
    await editVariable(w, x, { defaultValue: other.userId });
    const current = await varRow(w, x.id);
    const response = await publishWith(w, saved, {
      pendingResolutions: [
        { variableId: x.id, revision: current.revision, choice: 'designer' },
        { variableId: x.id, revision: current.revision, choice: 'current' },
      ],
    });
    await rejected(response, 400, 'APPROVAL_PENDING_RESOLUTION_INVALID');
    expect(await varRow(w, x.id)).toEqual(current);
    expect((await readProcess(w, saved.id)).latestVersion.status).toBe('draft');
  });
});

describe('AC-APV-F326-S7a-r2 P2-4 pendingConflict 与发布同一判定', () => {
  it('变量页被改成与待生效人员相同 → 读视图不报冲突', async () => {
    const { w, a2, x, saved } = await pendingWorld('s7a-r2-same');
    const edited = await editVariable(w, x, { defaultValue: a2.userId });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const view = nodeAutoView(await readProcess(w, saved.id), 'n2');
    expect(view).toMatchObject({ pendingUserIds: [a2.userId], userIds: [a2.userId] });
    expect(view!.pendingConflict).toBeUndefined();
    const published = await publishWith(w, saved);
    expect(published.status, await published.clone().text()).toBe(200);
  });

  it('变量已被管理员停用 → 读视图不报冲突（发布时新建）', async () => {
    const { w, x, saved } = await pendingWorld('s7a-r2-disabled');
    const { total } = await references(w, 'variables', x.id);
    const off = await variableCommand(w, await varRow(w, x.id), 'disable', { acknowledgedReferenceCount: total });
    expect(off.status, await off.clone().text()).toBe(200);
    const view = nodeAutoView(await readProcess(w, saved.id), 'n2');
    expect(view).toMatchObject({ status: 'disabled', pendingUserIds: expect.any(Array) });
    expect(view!.pendingConflict).toBeUndefined();
  });

  it('对照：变量页改成第三人 → 仍报冲突', async () => {
    const { w, other, x, saved } = await pendingWorld('s7a-r2-diff');
    await editVariable(w, x, { defaultValue: other.userId });
    expect(nodeAutoView(await readProcess(w, saved.id), 'n2')!.pendingConflict).toBe(true);
  });
});

describe('AC-APV-F326-S7a-r2 P2-6 草稿期限制按位置（节点 × 位置），不止按节点', () => {
  it('同节点的审批人位置变量被空人位置引用 → 422 APPROVAL_SOURCE_AUTO_VARIABLE_UNPUBLISHED，事务不留写入', async () => {
    const w = await s4World(database().db, 's7a-r2-slot');
    const handover = (approver: NodeInput['approvers'], empty: NodeInput['approvers']) =>
      ({
        ...counter(approver!, { key: 'work_handover' }),
        emptyApproverPolicy: 'specified',
        emptyApproverSources: empty,
      }) as NodeInput;
    const process = await create(w, [single('seed', w.near.userId)], { approvalType: 'exit_handover' });
    const saved = await draftOk(w, process, [handover([specified(w.near.userId)], [placeholder])]);
    const x = (await autoRows(w, process.id)).find(
      (row) => row.origin_slot === 'approver' && row.status === 'enabled',
    )!;
    const rows = await variableCount(w);
    const revision = (await readProcess(w, process.id)).revision;

    const response = await saveDraft(w, saved, [handover([publicVar(x.id)], [publicVar(x.id)])]);
    await rejected(response, 422, 'APPROVAL_SOURCE_AUTO_VARIABLE_UNPUBLISHED');
    expect(await variableCount(w)).toBe(rows);
    expect((await readProcess(w, process.id)).revision).toBe(revision);
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create']);
  });
});

describe('AC-APV-F326-S7a-r2 P2-7 自动生成不得写出超过 100 人的 persons 默认值', () => {
  it('会签 100 人通过，101 人 400 DEFAULT_VALUE_TYPE 且整笔回滚；继承变量改为 101 人同样拒绝', async () => {
    const w = await s4World(database().db, 's7a-r2-headcount');
    const crowd: string[] = [];
    for (let i = 0; i < 101; i += 1) crowd.push((await w.person(`合成人员${i}`, w.staff)).userId);
    const created = await create(w, [counter([specified(w.near.userId)])]);
    const rows = await variableCount(w);
    const revision = (await readProcess(w, created.id)).revision;

    const over = await saveDraft(w, created, [counter(crowd.map(specified))]);
    await rejected(over, 400, 'DEFAULT_VALUE_TYPE');
    expect(await variableCount(w)).toBe(rows);
    expect((await readProcess(w, created.id)).revision).toBe(revision);

    const exact = await saveDraft(w, created, [counter(crowd.slice(0, 100).map(specified))]);
    expect(exact.status, await exact.clone().text()).toBe(200);
    expect(peopleOf((await autoRows(w, created.id))[0]!)).toHaveLength(100);

    const published = await w.publish(await w.json<Awaited<ReturnType<typeof create>>>(exact));
    const x = (await autoRows(w, published.id))[0]!;
    const draft = await newVersion(w, published);
    const pending = await saveDraft(w, draft, [counter(crowd.map(specified))]);
    await rejected(pending, 400, 'DEFAULT_VALUE_TYPE');
    expect(await varRow(w, x.id)).toEqual(x);
  });
});

describe('AC-APV-F326-S7a-r2 P3 审计归位与停用原因', () => {
  it('选“采用设计器值”发布 → auto_update 的 after.trigger 内带 resolution，after 根层没有', async () => {
    const { w, other, x, saved } = await pendingWorld('s7a-r2-resolution');
    await editVariable(w, x, { defaultValue: other.userId });
    const current = await varRow(w, x.id);
    const done = await publishWith(w, saved, {
      pendingResolutions: [{ variableId: x.id, revision: current.revision, choice: 'designer' }],
    });
    expect(done.status, await done.clone().text()).toBe(200);
    const last = (await audits(w, x.id)).at(-1)!;
    expect(last.action).toBe('approval.public_variable.auto_update');
    expect(last.after).toMatchObject({
      trigger: { kind: 'publish', versionId: saved.latestVersion.id, resolution: 'designer' },
    });
    expect(last.after).not.toHaveProperty('resolution');
  });

  it('节点会签 ↔ 单人切换：旧占位变量 auto_disable 的 reason 与收尾同口径“不再被引用”', async () => {
    const w = await s4World(database().db, 's7a-r2-switch');
    const created = await create(w, [single('n1', w.near.userId)]);
    const x = (await autoRows(w, created.id))[0]!;
    await draftOk(w, created, [counter([specified(w.near.userId)])]);
    const last = (await audits(w, x.id)).at(-1)!;
    expect(last.action).toBe('approval.public_variable.auto_disable');
    expect(last.after).toMatchObject({ reason: '不再被引用' });
  });
});
