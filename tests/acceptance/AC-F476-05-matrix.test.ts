/**
 * AC-F476-05（P3 部分）：每种办理出口都验证两件事——办理人读到办理那一刻的内容（冻结份），接手人读现值。
 * 办理后由接手人用“单独编辑”把名称改成 C，再从审批中心与组织调整两个入口各读一遍；不只覆盖同意。
 * 同意 / 驳回上一步 / 跳转 / 转交 / 前加签 / 后加签；不同意与并加签另有断言。
 */
import { approverSource, ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput, Person } from './AC-APV-support.js';
import { type FlowWorld, flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { rename } from './AC-OA-items-support.js';
import { NAME_A, NAME_C, type Scenario, copiesOf, post, seenBy } from './AC-F476-support.js';

const testDb = useTestDb();
const ACTIONS = { transfer: true, addSign: true, rejectToPrevious: true, jump: true, copySend: true };
const EDITABLE = ['subject', 'orgItems.name'];
const nodes = () =>
  oaNodes([{ actions: ACTIONS }, { actions: ACTIONS, editMode: 'separate', editableFields: EDITABLE }]);

async function started(label: string, over: NodeInput[] = nodes()) {
  const w = await flowWorld(testDb().db, label, { nodes: over });
  const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
  await w.submitted(id);
  const scenario: Scenario = { id, itemId, instanceId: (await w.instance(id)).id };
  return { w, scenario };
}

/** 接手人用单独编辑把名称改成 C（现值变化）。 */
async function editToC(w: FlowWorld, s: Scenario, who: Person) {
  const res = await w.act(s.id, who, 'edit', { fields: { 'orgItems.name': [{ itemId: s.itemId, value: NAME_C }] } });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** 两个入口读到的名称与来源（审批中心、组织调整详情 / 明细）。 */
async function reads(w: FlowWorld, s: Scenario, user: Person) {
  const seen = await seenBy(w, s, user.userId);
  expect(seen.orgStatus, `${user.name} 读组织调整`).toBe(200);
  expect(seen.orgNames, `${user.name} 两入口一致`).toEqual(seen.centerNames);
  return { mode: seen.mode, names: seen.centerNames };
}

const FROZEN_A = { mode: 'frozen', names: [NAME_A] };
const LIVE_A = { mode: 'live', names: [NAME_A] };
const LIVE_C = { mode: 'live', names: [NAME_C] };

describe('AC-F476-05 办理出口矩阵：办理人读冻结份，接手人读现值', () => {
  it('同意：HRBP 冻结 A；负责人编辑成 C 后读现值', async () => {
    const { w, scenario } = await started('f476-05-approve');
    await w.acted(scenario.id, w.hrbp, 'approve');
    await editToC(w, scenario, w.head);
    expect(await reads(w, scenario, w.hrbp)).toEqual(FROZEN_A);
    expect(await reads(w, scenario, w.head)).toEqual(LIVE_C);
  });

  it('跳转（n1 → n2）：HRBP 冻结 A；负责人读现值 C', async () => {
    const { w, scenario } = await started('f476-05-jump');
    const res = await post(w, scenario.id, w.hrbp, 'jump', { toNodeKey: 'n2', comment: '合成意见' });
    expect(res.status, await res.clone().text()).toBe(200);
    await editToC(w, scenario, w.head);
    expect(await reads(w, scenario, w.hrbp)).toEqual(FROZEN_A);
    expect(await reads(w, scenario, w.head)).toEqual(LIVE_C);
  });

  it('驳回上一步（n2 → n1）：负责人冻结 A；HRBP 重新待办读现值 C，HRBP 原先的 n1 份不动', async () => {
    const { w, scenario } = await started('f476-05-reject-previous');
    await w.acted(scenario.id, w.hrbp, 'approve');
    const back = await post(w, scenario.id, w.head, 'reject-previous', { comment: '合成意见' });
    expect(back.status, await back.clone().text()).toBe(200);
    await editToC(w, scenario, w.hrbp);
    expect(await reads(w, scenario, w.head)).toEqual(FROZEN_A);
    expect(await reads(w, scenario, w.hrbp)).toEqual(LIVE_C);
    const mine = (await copiesOf(w, scenario.instanceId)).filter((c) => c.actor_user_id === w.hrbp.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(NAME_A);
  });

  it('转交：转出人冻结 A；接手人编辑成 C 后读现值，转出人不受影响', async () => {
    const { w, scenario } = await started('f476-05-transfer');
    const taker = await w.person('接手人', w.subject);
    const res = await post(w, scenario.id, w.hrbp, 'transfer', { toUserId: taker.userId, comment: '合成意见' });
    expect(res.status, await res.clone().text()).toBe(200);
    await editToC(w, scenario, taker);
    expect(await reads(w, scenario, w.hrbp)).toEqual(FROZEN_A);
    expect(await reads(w, scenario, taker)).toEqual(LIVE_C);
  });

  it('前加签：原人冻结 A（加签挂起时）；加签人读现值 C', async () => {
    const { w, scenario } = await started('f476-05-sign-before');
    const signer = await w.person('前加签人', w.subject);
    const res = await post(w, scenario.id, w.hrbp, 'add-sign', {
      userIds: [signer.userId],
      type: 'before',
      comment: '合成意见',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await reads(w, scenario, w.hrbp)).toEqual(FROZEN_A);
    expect(await reads(w, scenario, signer)).toEqual(LIVE_A);
  });

  it('后加签：原人的同意冻结 A；加签人读现值 C', async () => {
    const { w, scenario } = await started('f476-05-sign-after');
    const signer = await w.person('后加签人', w.subject);
    const res = await post(w, scenario.id, w.hrbp, 'add-sign', {
      userIds: [signer.userId],
      type: 'after',
      comment: '合成意见',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await reads(w, scenario, w.hrbp)).toEqual(FROZEN_A);
    expect(await reads(w, scenario, signer)).toEqual(LIVE_A);
  });

  it('不同意：HRBP 冻结 A，发起人读现值', async () => {
    const { w, scenario } = await started('f476-05-disagree');
    await w.acted(scenario.id, w.hrbp, 'disagree');
    expect(await reads(w, scenario, w.hrbp)).toEqual(FROZEN_A);
    const initiator = await seenBy(w, scenario, w.hr.id);
    expect(initiator.mode).toBe('live');
  });

  it('并加签（会签节点）：发起不冻结；并加签人同意后各人一份，原人此前仍读现值', async () => {
    const joint: NodeInput = {
      key: 'n1',
      name: '会签',
      kind: 'countersign',
      approvers: [approverSource('approval_subject_org_hrbp'), approverSource('approval_subject_org_head')],
      formFields: ORG_ADJUSTMENT_FORM_FIELDS,
      editMode: 'separate',
      editableFields: EDITABLE,
      actions: ACTIONS,
    };
    const { w, scenario } = await started('f476-05-parallel', [joint]);
    const signer = await w.person('并加签人', w.subject);
    const res = await post(w, scenario.id, w.hrbp, 'add-sign', {
      userIds: [signer.userId],
      type: 'parallel',
      comment: '合成意见',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await copiesOf(w, scenario.instanceId)).toHaveLength(0);
    await editToC(w, scenario, w.hrbp); // 加签人不能编辑，由原审批人改
    expect(await reads(w, scenario, w.hrbp)).toEqual(LIVE_C); // 原人还有 pending：读现值
    await w.acted(scenario.id, signer, 'approve');
    expect(await reads(w, scenario, signer)).toEqual({ mode: 'frozen', names: [NAME_C] });
    expect(await reads(w, scenario, w.hrbp)).toEqual(LIVE_C);
  });
});
