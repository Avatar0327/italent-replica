/**
 * F-048 PR-2 身份变化（设计 §2.2、§7、§12.1 Q13，测试 T12）：账号集合 U(S) 在发起 / 重提时冻结——
 * 冻结前已绑定的账号命中；冻结后才首次绑定的账号本轮不追溯（仍可被转交并继续办理），重提重新冻结后命中。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { bind, frozenOf, NODES, pendingOf, reasonOf, useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const BASE = '/api/tenant/approval';

describe('T12 冻结前后的账号绑定', () => {
  it('冻结前已绑定 → 转交命中 409；冻结后首次绑定 → 本轮不命中且可继续办理，重提后命中', async () => {
    const w = await approvalWorld(database().db, 'f048-identity');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [{ ...NODES.outHead, actions: { avoidSubjects: true, transfer: true } }, NODES.inHrbp],
    });
    const early = await w.employee('冻结前已绑定员工');
    const earlyUser = await bind(w, early.id, '冻结前账号');
    const late = await w.employee('冻结后才绑定员工');
    mapSubjects(() => [early.id, late.id]);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    const round1 = (await frozenOf(w, view.id)).filter((row) => row.round === 1);
    expect(round1.find((row) => row.employee_id === early.id)?.user_id).toBe(earlyUser);
    expect(round1.find((row) => row.employee_id === late.id)?.user_id).toBeNull();

    const transfer = (userId: string, current: InstanceView) =>
      w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${pendingOf(current)[0]!.id}/transfer`, {
        ifMatch: current.revision,
        body: { toUserId: userId },
      });
    expect(await reasonOf(await transfer(earlyUser, view))).toMatchObject({
      status: 409,
      reason: 'APPROVAL_SELF_REVIEW',
      recusal: 'subjects',
    });

    // 冻结之后的首次绑定不追溯：本轮仍可转交给该账号，其继续办理（这里选择驳回，以便走到重提）
    const lateUser = await bind(w, late.id, '冻结后账号');
    expect((await frozenOf(w, view.id)).find((row) => row.employee_id === late.id)?.user_id).toBeNull();
    view = await w.json(await transfer(lateUser, view));
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: lateUser })]);
    const returned = await w.json<InstanceView>(
      await w.taskAction(lateUser, pendingOf(view)[0]!.id, 'reject', view.revision),
    );
    expect(returned.status).toBe('returned');

    // 重提：第 2 轮重新冻结，账号取此刻的绑定；之后该账号命中
    const business = await w.business(draft.id);
    await w.json(await w.submitRaw({ id: draft.id, revision: business.revision }));
    view = await w.instanceOf(draft.id);
    const round2 = (await frozenOf(w, view.id)).filter((row) => row.round === 2);
    expect(round2.find((row) => row.employee_id === late.id)?.user_id).toBe(lateUser);
    expect(round2.find((row) => row.employee_id === early.id)?.user_id).toBe(earlyUser);
    expect(await reasonOf(await transfer(lateUser, view))).toMatchObject({
      status: 409,
      reason: 'APPROVAL_SELF_REVIEW',
      recusal: 'subjects',
    });
  });

  it('Q13：单主体业务按冻结值判断——单主体账号未激活也在冻结值里，视为本人回避', async () => {
    const w = await approvalWorld(database().db, 'f048-identity-primary');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [{ ...NODES.outHead, actions: { avoidSelf: true, transfer: true } }, NODES.inHrbp],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const response = await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${pendingOf(view)[0]!.id}/transfer`, {
      ifMatch: view.revision,
      body: { toUserId: s.subject.userId },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW', recusal: 'self' });
  });
});
