/**
 * AC-F476-13（P4 部分）：任职 / 离退类审批的冻结内容——失败闭合、披露范围、批准不等于生效、变更前取自正确版本。
 * 本片覆盖：transfer / hire / regularization / intern_regularization / leave / retirement 的三个人事详情入口。
 * 留给 P5：合同 4 操作 / 兼职 2 操作；留给 P7：考核 2 类 / 意向退休；其余类型留给 P6、P8、P9。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  BEFORE,
  EMP,
  changeAfterHandled,
  entriesOf,
  handledScene,
  readsBy,
  type ScenarioKind,
} from './AC-F476-p4-support.js';

const testDb = useTestDb();
const KINDS: ScenarioKind[] = ['transfer', 'hire', 'regularization', 'intern_regularization', 'leave', 'retirement'];

describe.each(KINDS)('AC-F476-13 P4 %s：失败闭合（DEC-807）', (kind) => {
  it('已办缺办理份：各入口 503，不退回现值；发起人不受影响', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-13-miss-${kind}`, kind);
    await changeAfterHandled(scene);
    const { w, approver } = scene;
    await w.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
      await tx.execute(sql`ALTER TABLE approval_handling_contents DISABLE TRIGGER USER`);
      await tx.execute(sql`DELETE FROM approval_handling_contents WHERE actor_user_id = ${approver.userId}::uuid`);
      await tx.execute(sql`ALTER TABLE approval_handling_contents ENABLE TRIGGER USER`);
    });
    const reads = await readsBy(scene, approver.userId);
    for (const entry of entriesOf(kind)) expect(reads[entry].status, `${kind}/${entry}`).toBe(503);
    const initiator = await readsBy(scene, w.hr.id);
    for (const entry of entriesOf(kind)) expect(initiator[entry].status, `${kind}/${entry}`).toBe(200);
  });
});

describe('AC-F476-13 P4 披露范围（D2=A：节点表单 ∩ 当前权限）', () => {
  it('transfer：节点表单只含部门，已办读取不披露办理时的地点', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-13-form-transfer', 'transfer', {
      nodeForm: ['departmentId'],
    });
    const approver = await readsBy(scene, scene.approver.userId);
    expect(approver.business.status).toBe(200);
    expect(approver.business.body.contentView?.mode).toBe('frozen');
    expect(approver.business.body.fields?.departmentId).toEqual(expect.any(String));
    expect(approver.business.body.fields).not.toHaveProperty('place');
    // 发起人读现值，不受节点表单限制
    expect((await readsBy(scene, scene.w.hr.id)).business.body.fields?.place).toBe(BEFORE);
  });

  it('leave：节点表单只含最后工作日，已办读取不披露结算类扩展字段与加黑明细', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-13-form-leave', 'leave', {
      nodeForm: ['lastWorkDate'],
      exit: { addToBlacklist: true, blacklistReason: 'integrity', compensationAmount: 1234 },
    });
    const approver = await readsBy(scene, scene.approver.userId);
    expect(approver.exit.status).toBe(200);
    expect(approver.exit.body.contentView?.mode).toBe('frozen');
    for (const key of ['employerName', 'compensationAmount', 'blacklistReason'])
      expect(approver.exit.body, key).not.toHaveProperty(key);
    const initiator = await readsBy(scene, scene.w.hr.id);
    expect(initiator.exit.body).toMatchObject({ employerName: BEFORE, blacklistReason: 'integrity' });
  });

  it('leave：加黑原因 / 说明不在审批表单里，即使节点表单放开全部离职字段，已办读取也不披露', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-13-blacklist', 'leave', {
      nodeForm: ['lastWorkDate', 'employerName', 'addToBlacklist'],
      exit: { addToBlacklist: true, blacklistReason: 'integrity' },
    });
    const approver = await readsBy(scene, scene.approver.userId);
    expect(approver.exit.body.contentView?.mode).toBe('frozen');
    expect(approver.exit.body.employerName).toBe(BEFORE);
    expect(approver.exit.body).not.toHaveProperty('blacklistReason');
  });
});

describe('AC-F476-13 P4 批准不等于生效（未来生效日）', () => {
  it('transfer 批准后未到生效日：已办读取标明 frozen，业务仍是 approved，人事主数据入口没有这条记录', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-13-approved', 'transfer', { action: 'approve' });
    const approver = await readsBy(scene, scene.approver.userId);
    expect(approver.business.status).toBe(200);
    expect(approver.business.body).toMatchObject({ status: 'approved', record: null });
    expect(approver.business.body.contentView?.mode).toBe('frozen');
    const record = await scene.w.request(scene.approver.userId, 'GET', `${EMP}/records/${scene.businessId}`);
    expect(record.status).toBe(404);
  });

  it('leave 批准后未到生效日：已办读取的扩展字段是办理时的值，/exits 仍显示未生效', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-13-approved-leave', 'leave', { action: 'approve' });
    const approver = await readsBy(scene, scene.approver.userId);
    expect(approver.exit.body).toMatchObject({ employerName: BEFORE });
    expect(approver.exit.body.contentView?.mode).toBe('frozen');
    expect(approver.exit.body.status).toBe('approved');
  });
});

describe('AC-F476-13 P4 变更前取自正确版本', () => {
  it('transfer：办理后把生效日改到更早，审批中心的“变更前”仍是办理时那一版的前驱', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-13-originals', 'transfer', {
      predecessor: { place: 'ZZ_中间地点', effectiveDate: '2026-09-15' },
    });
    const { w, approver, businessId, instanceId } = scene;
    const business = await w.business(businessId);
    const moved = await w.request(w.hr.id, 'PATCH', `${EMP}/businesses/${businessId}`, {
      ifMatch: business.revision,
      body: { effectiveDate: '2026-09-01' },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const live = await w.detail(instanceId, w.hr.id);
    const frozen = await w.detail(instanceId, approver.userId);
    expect(live.form.originals?.place).not.toBe('ZZ_中间地点');
    expect(frozen.form.originals?.place).toBe('ZZ_中间地点');
  });
});
