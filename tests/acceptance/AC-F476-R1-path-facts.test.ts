/**
 * F-476 P1 第 1 轮返工 P2-2：已办冻结份只供“展示”；当前路径推演（pendingWalk）用的条件值必须是当前流程事实
 * （设计 §0.2：实例状态、最新待办、动作、路径仍是当前流程事实，不回退成历史）。
 * 场景：流程按审批主体组织分支；原 HRBP（A 组织）驳回 → 申请人把主体改为 B 并重提 → B 组织 HRBP 待办。
 * 原 HRBP 读详情：内容仍是办理时的 A，但路径与新待办人看到的当前路径一致。
 */
import { approverSource } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { ApprovalWorld } from './AC-APV-support.js';
import { approveTo, otherwise, republishRouted, when } from './AC-APV-F478-support.js';
import { SUBJECT_A, SUBJECT_B } from './AC-F476-support.js';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

interface PathView {
  path: { nodeKey: string; state: string }[];
  form: { values: Record<string, unknown> };
  contentView?: { mode: string };
}

describe('AC-F476-R1 冻结份不污染当前路径推演', () => {
  it('原 HRBP（已办、读冻结 A）与新 HRBP（待办）看到的当前路径一致；内容仍是 A', async () => {
    const [n1, n2] = oaNodes();
    const n3 = { ...n2!, key: 'n3', name: '备选负责人审批', approver: approverSource('approval_subject_org_head') };
    const w = await flowWorld(testDb().db, 'f476-r1-path', { nodes: [n1!, n2!, n3] });
    // republishRouted 只用 db / tenant / hr；flowWorld 的 submit 签名不同，故收窄转换
    await republishRouted(w as unknown as ApprovalWorld, w.process, {
      n1: [approveTo(when(1, 'eq', w.subject, 'n2', 'adjustment.approvalSubjectOrgId'), otherwise('n3'))],
    });
    const orgB = await w.org(`主体二${uniqueSuffix()}`);
    const hrbpB = await w.person(`HRBP二${uniqueSuffix()}`, orgB);
    const headB = await w.person(`负责人二${uniqueSuffix()}`, orgB);
    await w.setOrgRoles(orgB, { hrbp: hrbpB.employeeId, head: headB.employeeId });

    const { id } = await w.draft();
    const first = await w.patch(id, { subject: SUBJECT_A }, await w.revisionOf(id));
    expect(first.status, await first.clone().text()).toBe(200);
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'reject'); // 原 HRBP 办理（驳回），留下冻结份（主体组织 = 原组织）
    const changed = await w.patch(id, { subject: SUBJECT_B, approvalSubjectOrgId: orgB }, await w.revisionOf(id));
    expect(changed.status, await changed.clone().text()).toBe(200);
    const resubmit = await w.instanceAction(id, 'resubmit');
    expect(resubmit.status, await resubmit.clone().text()).toBe(200);

    const view = await w.instance(id);
    expect(view.tasks.some((t) => t.status === 'pending' && t.assigneeUserId === hrbpB.userId)).toBe(true);
    const read = async (user: string) => (await w.detail(view.id, user)) as unknown as PathView;
    const fresh = await read(hrbpB.userId);
    const old = await read(w.hrbp.userId);

    expect(old.contentView?.mode).toBe('frozen');
    expect(old.form.values.subject).toBe(SUBJECT_A); // 展示仍是办理时内容
    expect(fresh.contentView?.mode).toBe('live');
    // 现值主体 = B 组织 → 走 else（n3）；冻结份里的 A 组织会错推成 n2
    expect(fresh.path.find((s) => s.nodeKey === 'n3')?.state).toBe('pending');
    expect(old.path).toEqual(fresh.path);
  });
});
