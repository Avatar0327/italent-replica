/**
 * F-476 P5 第 1 轮审查返工 P2-1：三个申请详情入口在「授权器自开租户事务」（与生产授权器同形）下不得阻塞。
 * 生产授权器在自己的租户事务里判断；入口已占用 withTenant 的唯一连接（PGlite）时，必须先用 authorizeInTransaction
 * 绑定到当前事务，否则管理员按钮判断会重入根事务而永久等待。读取方有无关联审批实例才会走到这条路径，
 * 所以每个入口都先造出审批实例；结果状态不是重点（只断言请求返回了），超时即判红。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import {
  contractScene,
  latestInstance,
  personnelScene,
  textFieldsOf,
  transactionalRights,
} from './AC-F476-p5-support.js';

const testDb = useTestDb();
const WAIT = 20_000;

describe('F-476 P5 R1 授权器自开事务时的三个详情入口', () => {
  it('合同申请详情不阻塞', { timeout: WAIT }, async () => {
    const s = await contractScene(testDb().db, 'f476-r2-real-contract');
    const request = await s.apply('create', {});
    await latestInstance(s.w, 'contract', request.id);
    const res = await transactionalRights(s.w).get(s.n1.userId, s.requestPath(request.id));
    expect(res.status).toBe(200);
  });

  it('子集申请详情不阻塞', { timeout: WAIT }, async () => {
    const s = await personnelScene(testDb().db, 'f476-r2-real-personnel');
    const request = await s.apply('education', { [textFieldsOf('education')[0]!]: 'ZZ_合成值' });
    await latestInstance(s.w, 'personnel_change', request.id);
    const res = await transactionalRights(s.w).get(s.subject.userId, s.requestPath(request.id));
    expect(res.status).toBe(200);
  });

  it('兼职申请详情不阻塞', { timeout: WAIT }, async () => {
    const w = await requestWorld(testDb().db, 'f476-r2-real-pt');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    const res = await transactionalRights(w).get(w.hr.id, `/api/tenant/employment/part-time-requests/${created.id}`);
    expect(res.status).toBe(200);
  });
});
