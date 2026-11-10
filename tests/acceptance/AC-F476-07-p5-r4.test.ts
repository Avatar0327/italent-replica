/**
 * F-476 P5 第 3 轮审查返工（PR #651）P2：子集申请详情的申请元数据（申请对象 TenantBase.PersonalInformationChange 的
 * employeeId、recordId 等，字段目录见 packages/domain/src/personnel/catalog.ts）同样受「办理时申请对象披露上限」与
 * 「当前申请对象字段权」两道约束：办理时看不到的字段，办理后补授权也不补露（设计 §5.2）。
 */
import { PERSONNEL_REQUEST_OBJECT, type SubsetKind } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { latestInstance, personnelScene, rights, textFieldsOf } from './AC-F476-p5-support.js';

const testDb = useTestDb();
const subset: SubsetKind = 'education';
const [field, kept] = textFieldsOf(subset) as [string, string];

describe('F-476 P5 R3 子集申请元数据：办理时上限 ∩ 当前字段权（P2）', () => {
  it('n1 办理时无 employeeId / recordId 权、办理后补授权：n1 冻结读仍隐藏；n2 办理时有权照常显示', async () => {
    const s = await personnelScene(testDb().db, 'f476-r4-subset-meta');
    const r = rights(s.w);
    const target = await s.record(subset, { [field]: 'ZZ_原值', [kept]: 'ZZ_保持' });
    const request = await s.apply(subset, { [field]: 'ZZ_办理时', [kept]: 'ZZ_保持' }, target);
    const instance = await latestInstance(s.w, 'personnel_change', request.id);

    r.hide(PERSONNEL_REQUEST_OBJECT, 'employeeId', 'recordId');
    await r.decide(instance.id, s.n1, 'approve');
    r.show(PERSONNEL_REQUEST_OBJECT, 'employeeId', 'recordId');
    await r.decide(instance.id, s.n2, 'approve');

    const blind = await r.get(s.n1.userId, s.requestPath(request.id));
    expect(blind.status).toBe(200);
    expect(blind.body.contentView?.mode).toBe('frozen');
    const blindKeys = Object.keys(blind.body);
    expect(blindKeys, '办理时可见的子集类型照常披露').toContain('subset');
    expect(blindKeys, '办理时不可见的员工 ID 不得补露').not.toContain('employeeId');
    expect(blindKeys, '办理时不可见的目标记录 ID 不得补露').not.toContain('recordId');
    expect(Object.keys((blind.body.currentValues ?? {}) as object), '子集容器不受申请对象上限影响').toContain(field);

    const seen = await r.get(s.n2.userId, s.requestPath(request.id));
    expect(seen.status).toBe(200);
    expect(seen.body.contentView?.mode).toBe('frozen');
    expect(seen.body.employeeId).toBe(s.subject.employeeId);
    expect(seen.body.recordId).toBe(target.id);
  });

  it('办理后撤权：已办人冻结读按当前字段权隐藏（上限不放宽当前权限）', async () => {
    const s = await personnelScene(testDb().db, 'f476-r4-subset-meta-revoke');
    const r = rights(s.w);
    const target = await s.record(subset, { [field]: 'ZZ_原值', [kept]: 'ZZ_保持' });
    const request = await s.apply(subset, { [field]: 'ZZ_办理时', [kept]: 'ZZ_保持' }, target);
    const instance = await latestInstance(s.w, 'personnel_change', request.id);
    await r.decide(instance.id, s.n1, 'approve');
    r.hide(PERSONNEL_REQUEST_OBJECT, 'recordId');

    const read = await r.get(s.n1.userId, s.requestPath(request.id));
    expect(read.body.contentView?.mode).toBe('frozen');
    expect(read.body.employeeId).toBe(s.subject.employeeId);
    expect(Object.keys(read.body)).not.toContain('recordId');
  });
});
