/**
 * F-476 P5 第 2 轮审查返工（PR #651）：
 * - P1 兼职冻结读的员工分组同时受「办理时员工对象披露上限」与「当前员工字段权」两道约束：办理时看不到的姓名，
 *   办理后补授权也不补露（设计 §5.2）；撤权后隐藏另见 AC-F476-07-p5-r2 P2-3。
 * - 自查补漏：合同冻结读的非业务键（状态等，不在节点表单里）同样受办理上限约束，不只看当前字段权。
 * - P2-3 兼职申请 DTO 的 serviceType 统一按 partTimeType 权限编码投影：有 partTimeType 权、无 serviceType 权时
 *   申请详情（冻结读 / 现读）与审批中心都显示。
 */
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import { contractScene, latestInstance, rights } from './AC-F476-p5-support.js';

const testDb = useTestDb();
const PT = '/api/tenant/employment/part-time-requests';
const OBJECT = MODULE_OBJECTS.employmentRecord.code;
const EMPLOYEE = 'TenantBase.Employee';

async function partTime(label: string) {
  const w = await requestWorld(testDb().db, label);
  const r = rights(w);
  const record = await w.seedRecord({ endDate: '2026-10-31' });
  const created = await w.extend(record, '2026-12-31');
  await w.send(created.id, created.revision);
  const [first] = w.order.extend;
  const view = await w.instance(created.id);
  return { w, r, id: created.id, instanceId: view.id, first: first! };
}

describe('F-476 P5 R2 兼职员工分组：办理时上限 ∩ 当前字段权（P1）', () => {
  it('办理时无员工姓名权、办理后授权：已办人的冻结读仍不含姓名；现读视角按当前权限显示', async () => {
    const s = await partTime('f476-r3-pt-employee');
    s.r.hide(EMPLOYEE, 'name');
    await s.r.decide(s.instanceId, s.first, 'approve');
    s.r.show(EMPLOYEE, 'name');

    const frozen = await s.r.get(s.first.userId, `${PT}/${s.id}`);
    expect(frozen.status).toBe(200);
    expect(frozen.body.contentView?.mode).toBe('frozen');
    const employee = frozen.body.employee as Record<string, unknown> | null;
    expect(employee, '冻结读应带员工分组').not.toBeNull();
    expect(Object.keys(employee ?? {}), '办理时可见的工号照常披露').toContain('code');
    expect(Object.keys(employee ?? {}), '办理时不可见的姓名不得补露').not.toContain('name');

    const live = await s.r.get(s.w.hr.id, `${PT}/${s.id}`);
    expect(live.body.contentView?.mode).toBe('live');
    expect(Object.keys((live.body.employee as object | null) ?? {})).toContain('name');
  });
});

describe('F-476 P5 R2 自查：合同冻结读的非业务键受办理上限约束', () => {
  it('办理时无合同状态权、办理后授权：该已办人冻结读不含状态，办理时有权的另一已办人照常显示', async () => {
    const s = await contractScene(testDb().db, 'f476-r3-contract-meta');
    const r = rights(s.w);
    const request = await s.apply('create', {});
    const instance = await latestInstance(s.w, 'contract', request.id);
    r.hide(CONTRACT_OBJECT, 'status');
    await r.decide(instance.id, s.n1, 'approve');
    r.show(CONTRACT_OBJECT, 'status');
    await r.decide(instance.id, s.n2, 'approve');

    const blind = await r.get(s.n1.userId, s.requestPath(request.id));
    expect(blind.status).toBe(200);
    expect(blind.body.contentView?.mode).toBe('frozen');
    expect(Object.keys(blind.body)).not.toContain('status');
    const seen = await r.get(s.n2.userId, s.requestPath(request.id));
    expect(seen.body.contentView?.mode).toBe('frozen');
    expect(Object.keys(seen.body)).toContain('status');
  });
});

describe('F-476 P5 R2 兼职 serviceType ↔ partTimeType 投影一致（P2-3）', () => {
  it('有 partTimeType 权、无 serviceType 权：冻结读、现读与审批中心都显示任职类型', async () => {
    const s = await partTime('f476-r3-pt-type');
    s.r.hide(OBJECT, 'serviceType');
    await s.r.decide(s.instanceId, s.first, 'approve');

    const frozen = await s.r.get(s.first.userId, `${PT}/${s.id}`);
    expect(frozen.body.contentView?.mode).toBe('frozen');
    expect(frozen.body.serviceType).toBe('part_time');
    const centre = await s.r.detail(s.first.userId, s.instanceId);
    const values = (centre.body as { form?: { values?: Record<string, unknown> } }).form?.values ?? {};
    expect(Object.keys(values)).toContain('partTimeType');

    const live = await s.r.get(s.w.hr.id, `${PT}/${s.id}`);
    expect(live.body.contentView?.mode).toBe('live');
    expect(live.body.serviceType).toBe('part_time');
  });

  it('无 partTimeType 权：两个入口都不显示任职类型（即使有 serviceType 权）', async () => {
    const s = await partTime('f476-r3-pt-type-hidden');
    s.r.hide(OBJECT, 'partTimeType');
    await s.r.decide(s.instanceId, s.first, 'approve');
    const frozen = await s.r.get(s.first.userId, `${PT}/${s.id}`);
    expect(frozen.body.contentView?.mode).toBe('frozen');
    expect(Object.keys(frozen.body)).not.toContain('serviceType');
    const live = await s.r.get(s.w.hr.id, `${PT}/${s.id}`);
    expect(Object.keys(live.body)).not.toContain('serviceType');
  });
});
