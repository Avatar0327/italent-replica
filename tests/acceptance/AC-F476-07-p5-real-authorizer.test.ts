/**
 * F-476 P5 审查返工（第 1 轮 P2-1、第 2 轮 P2-2）：申请详情各入口在「授权器 / 字段提供方未传 Tx 时自开租户事务」
 * （与生产 permission/authorizer.ts 同形）下不得阻塞。入口已占用 withTenant 的唯一连接（PGlite）时，事务内的授权与
 * 字段权判断必须绑定到当前事务，否则会重入根事务而永久等待。三个模块各覆盖现读与冻结读两条路径（另含审批中心详情）；
 * 结果状态不是重点（只断言请求返回 200），超时即判红。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import {
  act,
  BASE,
  contractScene,
  latestInstance,
  personnelScene,
  textFieldsOf,
  transactionalRights,
} from './AC-F476-p5-support.js';

const testDb = useTestDb();
const WAIT = 20_000;
const PT = '/api/tenant/employment/part-time-requests';

describe('F-476 P5 授权器 / 字段提供方自开事务时的申请详情入口', () => {
  it('合同：待办人与发起人现读、已办人冻结读、审批中心详情都不阻塞', { timeout: WAIT }, async () => {
    const s = await contractScene(testDb().db, 'f476-r3-real-contract');
    const request = await s.apply('create', {});
    const instance = await latestInstance(s.w, 'contract', request.id);
    const real = transactionalRights(s.w);
    const pending = await real.get(s.n1.userId, s.requestPath(request.id));
    expect(pending.status).toBe(200);
    expect(pending.body.contentView?.mode).toBe('live');
    expect((await real.get(s.w.hr.id, s.requestPath(request.id))).status).toBe(200);
    await act(s.w, instance.id, s.n1, 'approve');
    const frozen = await real.get(s.n1.userId, s.requestPath(request.id));
    expect(frozen.status).toBe(200);
    expect(frozen.body.contentView?.mode).toBe('frozen');
    expect((await real.get(s.n1.userId, `${BASE}/instances/${instance.id}`)).status).toBe(200);
  });

  it('子集：本人现读、已办人冻结读、审批中心详情都不阻塞', { timeout: WAIT }, async () => {
    const s = await personnelScene(testDb().db, 'f476-r3-real-personnel');
    const request = await s.apply('education', { [textFieldsOf('education')[0]!]: 'ZZ_合成值' });
    const instance = await latestInstance(s.w, 'personnel_change', request.id);
    const real = transactionalRights(s.w);
    expect((await real.get(s.subject.userId, s.requestPath(request.id))).status).toBe(200);
    await act(s.w, instance.id, s.n1, 'approve');
    const frozen = await real.get(s.n1.userId, s.requestPath(request.id));
    expect(frozen.status).toBe(200);
    expect(frozen.body.contentView?.mode).toBe('frozen');
    expect((await real.get(s.n1.userId, `${BASE}/instances/${instance.id}`)).status).toBe(200);
  });

  it('兼职：HR 现读、已办人冻结读、审批中心详情都不阻塞', { timeout: WAIT }, async () => {
    const w = await requestWorld(testDb().db, 'f476-r3-real-pt');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    const real = transactionalRights(w);
    expect((await real.get(w.hr.id, `${PT}/${created.id}`)).status).toBe(200);
    const [first] = w.order.extend;
    await w.decide(created.id, first!, 'approve');
    const frozen = await real.get(first!.userId, `${PT}/${created.id}`);
    expect(frozen.status).toBe(200);
    expect(frozen.body.contentView?.mode).toBe('frozen');
    const instance = await w.instance(created.id);
    expect((await real.get(first!.userId, `${BASE}/instances/${instance.id}`)).status).toBe(200);
  });
});
