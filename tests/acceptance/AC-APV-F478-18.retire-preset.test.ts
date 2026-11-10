/**
 * AC-APV-F478-18（F-478 S4，设计 §6.4 / §10）：新租户安装退休预置 —— 4 节点 + 业务出口组 + 路由。
 * reEmployed=true 走完四节点，返聘后两节点取返聘计划的直线经理 / 部门 HRBP，整单通过后退休生效并生成返聘业务；
 * reEmployed=false 在 HRBP 节点结束，两节点即通过。真实 HTTP + 真实库 + 合成数据（预置经开通同一路径发布）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { publishPreset, readProcess } from './AC-APV-F478-s3-support.js';
import { retireScene } from './AC-APV-F478-s4-support.js';

const testDb = useTestDb();
const PAST_LAST_WORK_DAY = '2026-09-20';
const FUTURE_LAST_WORK_DAY = '2027-12-31';

describe('AC-APV-F478-18 退休预置', () => {
  it('安装读回：4 节点、HRBP 节点业务出口与两条路由', async () => {
    const s = await retireScene(testDb().db, 'f478-18-readback');
    await publishPreset(s.w, 'standard_retirement');
    const list = await s.w.json<{ items: { id: string; approvalType: string }[] }>(
      await s.w.request(s.w.hr.id, 'GET', '/api/tenant/approval/processes'),
    );
    const id = list.items.find((item) => item.approvalType === 'retirement')!.id;
    const process = await readProcess(s.w, id);
    expect(process.currentVersion).not.toBeNull();
    const nodes = process.latestVersion.nodes as unknown as { key: string; exits: string[]; routes?: unknown[] }[];
    expect(nodes.map((n) => n.key)).toEqual(['direct_head', 'hr_interview', 'rehire_manager', 'rehire_hrbp']);
    expect(nodes[1]!.exits).toEqual(['approve_no_rehire', 'approve_rehire']);
    expect(nodes[1]!.routes).toEqual([
      { exit: 'approve_no_rehire', branches: [{ kind: 'direct', target: 'END' }] },
      { exit: 'approve_rehire', branches: [{ kind: 'direct', target: 'rehire_manager' }] },
    ]);
  });

  it('reEmployed=true：走完四节点，返聘后节点取返聘计划的人；整单通过后退休生效并生成返聘业务', async () => {
    const s = await retireScene(testDb().db, 'f478-18-yes');
    await publishPreset(s.w, 'standard_retirement');
    let view = await s.retire(true, PAST_LAST_WORK_DAY);
    const seen: [string, string][] = [];
    for (let step = 0; step < 4; step++) {
      const task = s.w.pending(view)[0]!;
      seen.push([task.nodeKey, task.assigneeUserId!]);
      const exit = task.nodeKey === 'hr_interview' ? { exit: 'approve_rehire' } : {};
      view = await s.advance(view, { comment: '办理', ...exit });
    }
    expect(seen).toEqual([
      ['direct_head', s.manager],
      ['hr_interview', s.home.hrbp],
      ['rehire_manager', s.back.manager],
      ['rehire_hrbp', s.back.hrbp],
    ]);
    expect(view.status).toBe('approved');
    const businessId = (view as unknown as { businessId: string }).businessId;
    expect(await s.businessStatus(businessId)).toBe('effective');
    const extension = await s.extension(businessId);
    expect(extension).toMatchObject({ re_employed: true });
    expect(extension!.rehire_business_id).toBeTruthy();
  });

  it('reEmployed=false：HRBP 节点同意（不返聘）后结束，只有两个节点，不生成返聘业务', async () => {
    const s = await retireScene(testDb().db, 'f478-18-no');
    await publishPreset(s.w, 'standard_retirement');
    let view = await s.retire(false, PAST_LAST_WORK_DAY);
    view = await s.advance(view);
    expect(s.w.pending(view).map((t) => t.nodeKey)).toEqual(['hr_interview']);
    view = await s.advance(view, { comment: '办理', exit: 'approve_no_rehire' });
    expect(view.status).toBe('approved');
    const businessId = (view as unknown as { businessId: string }).businessId;
    expect((await s.extension(businessId))!.rehire_business_id).toBeNull();
  });
  it('reEmployed=true 且最后工作日在未来：四节点通过后单据 approved，退休业务仍是已批准，尚未生成返聘业务', async () => {
    const s = await retireScene(testDb().db, 'f478-18-future');
    await publishPreset(s.w, 'standard_retirement');
    let view = await s.retire(true, FUTURE_LAST_WORK_DAY);
    for (let step = 0; step < 4; step++) {
      const task = s.w.pending(view)[0]!;
      const exit = task.nodeKey === 'hr_interview' ? { exit: 'approve_rehire' } : {};
      view = await s.advance(view, { comment: '办理', ...exit });
    }
    expect(view.status).toBe('approved');
    const businessId = (view as unknown as { businessId: string }).businessId;
    // 审批通过 ≠ 生效：未来生效日由定时任务落地，返聘业务此时不存在。
    expect(await s.businessStatus(businessId)).toBe('approved');
    expect((await s.extension(businessId))!.rehire_business_id).toBeNull();
  });
});
