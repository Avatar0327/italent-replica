/**
 * AC-F476-08（P5 部分）：每个真实的合同 / 员工子集 / 兼职类型都走「办理 → 修改源单 / 重新发起 → 经申请详情读」。
 * 「留给 P4、P6～P9」：任职、Offer、考核、退休、发展计划、交接等类型。
 */
import { APPROVAL_INSTANCE_OBJECT, SUBSETS, type SubsetKind } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import {
  act,
  contractScene,
  get,
  latestInstance,
  personnelScene,
  resubmit,
  rights,
  textFieldOf,
  val,
} from './AC-F476-p5-support.js';

const testDb = useTestDb();
// qualification 不开放自助申请（AC-QL-subset：首次提交一律 403，不留申请与审批实例），没有走审批的入口，故不在逐项范围内。
const SUBSET_KINDS = (Object.keys(SUBSETS) as SubsetKind[]).filter((k) => k !== 'qualification');

describe('AC-F476-08 员工子集（逐 SUBSETS 注册项）：已办经申请详情读办理时的内容与原值', () => {
  it.each(SUBSET_KINDS)('%s：修正重提后，已办人读办理时值 + 原值，待办人与本人读现值', async (subset) => {
    const s = await personnelScene(testDb().db, `f476-08p5-${subset}`);
    const { w, n1, n2 } = s;
    const field = textFieldOf(subset);
    const target = await s.record(subset, { [field]: val(subset, '原值') });
    const request = await s.apply(subset, { [field]: val(subset, '办理时') }, target);
    const instance = await latestInstance(w, 'personnel_change', request.id);
    await act(w, instance.id, n1, 'approve');
    await act(w, instance.id, n2, 'reject');
    await resubmit(w, instance.id, s.subject.userId, { [field]: val(subset, '改后') });

    const handled = await get(w, n2.userId, s.requestPath(request.id));
    expect(handled.status, JSON.stringify(handled.body)).toBe(200);
    expect(handled.body.currentValues).toEqual({ [field]: val(subset, '办理时') });
    expect(handled.body.originals).toEqual({ [field]: val(subset, '原值') });
    expect(handled.body.contentView?.mode).toBe('frozen');
    const live = await get(w, s.subject.userId, s.requestPath(request.id));
    expect([live.status, live.body.currentValues, live.body.contentView?.mode]).toEqual([
      200,
      { [field]: val(subset, '改后') },
      'live',
    ]);
    // 重提后待办的审批人不是本人：申请详情走基线 requireSelf / preflight（R1 P1-2），不因参与审批而放宽；他在审批中心读
    const pending = await get(w, n1.userId, s.requestPath(request.id));
    expect(pending.status).toBe(404);
  });
});

describe('AC-F476-08 员工子集：无关人员不因办理视图而多读', () => {
  it('既非本人、不是参与人、也不是范围内流程管理员的同事，读申请详情仍是 404', async () => {
    const s = await personnelScene(testDb().db, 'f476-08p5-stranger');
    const { w, n1 } = s;
    const field = textFieldOf('education');
    const target = await s.record('education', { [field]: val('education', '原值') });
    const request = await s.apply('education', { [field]: val('education', '办理时') }, target);
    await act(w, (await latestInstance(w, 'personnel_change', request.id)).id, n1, 'approve');
    const noAdmin = (r: { action: string; resource?: string }) =>
      r.action === 'object.button' && (r.resource ?? '').startsWith(APPROVAL_INSTANCE_OBJECT);
    const r = rights(w, noAdmin);
    expect((await r.get(s.stranger.userId, s.requestPath(request.id))).status).toBe(404);
    expect((await r.get(n1.userId, s.requestPath(request.id))).status).toBe(200);
  });
});

describe('AC-F476-08 重新发起：旧申请的已办人仍读办理时内容，新申请按现值', () => {
  it.each(SUBSET_KINDS)('%s：撤回旧申请后对同一记录重新申请', async (subset) => {
    const s = await personnelScene(testDb().db, `f476-08p5-reissue-${subset}`);
    const { w, n1, n2 } = s;
    const field = textFieldOf(subset);
    const target = await s.record(subset, { [field]: val(subset, '原值') });
    const first = await s.apply(subset, { [field]: val(subset, '办理时') }, target);
    const instance = await latestInstance(w, 'personnel_change', first.id);
    await act(w, instance.id, n1, 'approve');
    await act(w, instance.id, n2, 'reject');
    const withdrawn = await w.instanceAction(
      s.subject.userId,
      instance.id,
      'withdraw',
      (await w.detail(instance.id)).revision,
    );
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    const second = await s.apply(subset, { [field]: val(subset, '第二次') }, target);

    const old = await get(w, n2.userId, s.requestPath(first.id));
    expect([old.status, old.body.currentValues, old.body.contentView?.mode]).toEqual([
      200,
      { [field]: val(subset, '办理时') },
      'frozen',
    ]);
    const fresh = await get(w, s.subject.userId, s.requestPath(second.id));
    expect([fresh.status, fresh.body.currentValues, fresh.body.contentView?.mode]).toEqual([
      200,
      { [field]: val(subset, '第二次') },
      'live',
    ]);
  });

  it('合同：撤回旧申请后重新申请，旧申请的已办人读办理时的结束日期', async () => {
    const s = await contractScene(testDb().db, 'f476-08p5-reissue-contract');
    const { w, n1, n2 } = s;
    const target = await s.direct();
    const first = await s.apply('change', { effectiveDate: '2025-03-01' }, target);
    const instance = await latestInstance(w, 'contract', first.id);
    await act(w, instance.id, n1, 'approve');
    await act(w, instance.id, n2, 'reject');
    const withdrawn = await w.instanceAction(w.hr.id, instance.id, 'withdraw', (await w.detail(instance.id)).revision);
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    const second = await s.apply('change', { effectiveDate: '2025-04-01' }, target);

    const old = await get(w, n2.userId, s.requestPath(first.id));
    expect([old.status, old.body.effectiveDate, old.body.contentView?.mode]).toEqual([200, '2025-03-01', 'frozen']);
    const fresh = await get(w, w.hr.id, s.requestPath(second.id));
    expect([fresh.body.effectiveDate, fresh.body.contentView?.mode]).toEqual(['2025-04-01', 'live']);
  });

  it('兼职：旧延长申请被 HR 作废后重新申请，旧申请的已办人读办理时的结束日期', async () => {
    const w = await requestWorld(testDb().db, 'f476-08p5-reissue-pt', { editMode: 'with_approve' });
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const first = await w.extend(record, '2026-12-31');
    await w.send(first.id, first.revision);
    const [approver, rejecter] = w.order.extend;
    await w.decide(first.id, approver!, 'approve');
    await w.decide(first.id, rejecter!, 'reject');
    await w.revoke(first.id, (await w.load(first.id)).revision);
    const second = await w.extend(record, '2027-03-31');
    await w.send(second.id, second.revision);

    const PT = '/api/tenant/employment/part-time-requests';
    const old = await get(w, approver!.userId, `${PT}/${first.id}`);
    expect([old.status, old.body.endDate, old.body.contentView?.mode]).toEqual([200, '2026-12-31', 'frozen']);
    const fresh = await get(w, w.hr.id, `${PT}/${second.id}`);
    expect([fresh.body.endDate, fresh.body.contentView?.mode]).toEqual(['2027-03-31', 'live']);
  });
});
