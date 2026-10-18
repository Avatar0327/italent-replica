/**
 * AC-PT-13（申请侧）兼职新增申请的内部服务（docs/08_设计/R2-T05_兼职设计.md §2.2 / §4.3A / §9 PB-63；PT-4a，无公开路由）：
 * 创建 / 修改 / 提交 / 撤回 / HR 撤销 / 删除的状态机，与“越过已生效离职的最后工作日一律当次拒绝、草稿也不豁免”（A-16）。
 * 日期框架：今天 2026-10-01，主职 2020-01-01 入职；离职最后工作日 09-15（生效日 09-16，已落地）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { nextPartTimeRequestState } from '@italent/domain';
import { requestWorld } from './AC-PT-request-support.js';

const database = useTestDb();

describe('草稿的创建与修改（D-1～D-10、周期边界）', () => {
  it('创建：写头 / 第 1 版 / draft 事件，流程编码创建时绑定，审计按兼职部门归属', async () => {
    const w = await requestWorld(database().db, 'create');
    const created = await w.create({ endDate: '2026-12-31', remark: '合成备注' });
    expect(created).toMatchObject({
      requestType: 'add',
      state: 'draft',
      revision: 1,
      versionNo: 1,
      initiator: 'hr',
      initiatorUserId: w.hr.id,
      processCode: 'AddParttimeJobProcess',
      departmentId: w.side,
      endDate: '2026-12-31',
      remark: '合成备注',
    });
    expect((await w.states(created.id)).map((row) => row.state)).toEqual(['draft']);
    expect(await w.auditActions(created.id)).toEqual(['part_time.request.create']);
    // 草稿不生成兼职记录
    expect(await w.partTimeRecords()).toEqual([]);
  });

  it('修改：合入改动后整体重校验，追加版本、revision +1；revision 不一致 409；审批中不能直接改', async () => {
    const w = await requestWorld(database().db, 'update');
    const created = await w.create({ endDate: '2026-12-31' });
    expect((await w.rejected(() => w.update(created.id, 9, { endDate: '2026-11-30' }))).code).toBe('REVISION_CONFLICT');
    const updated = await w.update(created.id, 1, { endDate: '2026-11-30', remark: null });
    expect(updated).toMatchObject({ versionNo: 2, revision: 2, endDate: '2026-11-30', state: 'draft' });
    expect(await w.auditActions(created.id)).toEqual(['part_time.request.create', 'part_time.request.update']);
    const submitted = await w.send(created.id, 2);
    expect(submitted.state).toBe('in_review');
    const direct = await w.rejected(() => w.update(created.id, submitted.revision, { endDate: '2026-10-31' }));
    expect(direct).toMatchObject({ code: 'CONFLICT', reason: 'PART_TIME_REQUEST_STATE_INVALID' });
  });

  it('D-1 / D-5 / 备注上限：结束早于开始 400；外派草稿再建外派 409，改自己的草稿不算冲突', async () => {
    const w = await requestWorld(database().db, 'rules');
    expect(await w.rejected(() => w.create({ startDate: '2026-09-10', endDate: '2026-09-01' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await w.rejected(() => w.create({ remark: 'x'.repeat(32767) }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const first = await w.create({ serviceType: 'secondment', endDate: '2026-12-31' });
    expect(await w.rejected(() => w.create({ serviceType: 'expatriate' }))).toMatchObject({
      code: 'CONFLICT',
      reason: 'PART_TIME_EXCLUSIVE_TYPE_EXISTS',
    });
    expect((await w.update(first.id, 1, { remark: '改备注' })).versionNo).toBe(2);
    // PT-7 前不接受负责人 / 新增下属（§4.8，PB-57 申请侧）
    expect(await w.rejected(() => w.create({ isDepartmentHead: true }))).toMatchObject({
      reason: 'PART_TIME_LINKAGE_NOT_AVAILABLE',
    });
  });
});

describe('PB-63 / A-16：周期内已有已生效离职（L = 09-15）时申请草稿的创建与修改', () => {
  it('结束日 = L 创建成功；空 / 09-20 创建即 409 且不建申请头、无审计；修改为空 409，版本数与内容不变', async () => {
    const w = await requestWorld(database().db, 'pb63');
    await w.leave('2026-09-15');
    const ok = await w.create({ endDate: '2026-09-15' });
    expect(ok.state).toBe('draft');
    const before = await w.writes();
    for (const endDate of [null, '2026-09-20']) {
      const error = await w.rejected(() => w.create({ endDate }));
      expect(error).toMatchObject({ code: 'CONFLICT', reason: 'PART_TIME_BEYOND_EXIT' });
      expect(error.details).toMatchObject({ lastWorkDate: '2026-09-15' });
    }
    expect(await w.writes()).toEqual(before);
    const blocked = await w.rejected(() => w.update(ok.id, 1, { endDate: null }));
    expect(blocked).toMatchObject({ code: 'CONFLICT', reason: 'PART_TIME_BEYOND_EXIT' });
    expect(await w.writes()).toEqual(before);
    const reread = await w.load(ok.id);
    expect(reread.version).toMatchObject({ versionNo: 1, endDate: '2026-09-15' });
    expect(reread.revision).toBe(1);
  });
});

describe('提交 / 撤回 / 撤销 / 删除', () => {
  it('提交只允许原发起人；提交时按最新版本复核（草稿之后冒出的未落地离职使开始日越界 → 提交 409，状态不变）', async () => {
    const w = await requestWorld(database().db, 'submit');
    const created = await w.create({ startDate: '2026-09-20', endDate: null });
    const stranger = await w.member('别的操作人');
    expect(await w.rejected(() => w.send(created.id, 1, stranger))).toMatchObject({
      code: 'FORBIDDEN',
      reason: 'PART_TIME_NOT_INITIATOR',
    });
    await w.pendingExit('2026-09-15');
    const error = await w.rejected(() => w.send(created.id, 1));
    expect(error).toMatchObject({ code: 'CONFLICT', reason: 'PART_TIME_AFTER_EXIT' });
    expect((await w.load(created.id)).state).toBe('draft');
  });

  it('提交 → 撤回回到草稿（实例撤回）→ 再提交沿用原实例；HR 撤销作废并取消实例，作废是终态', async () => {
    const w = await requestWorld(database().db, 'withdraw');
    const created = await w.create({ endDate: '2026-12-31' });
    const submitted = await w.send(created.id, 1);
    const first = await w.instance(created.id);
    expect(first.status).toBe('running');
    const withdrawn = await w.withdraw(created.id, submitted.revision);
    expect(withdrawn.state).toBe('draft');
    expect((await w.instance(created.id)).status).toBe('withdrawn');
    const again = await w.send(created.id, withdrawn.revision);
    expect(again.state).toBe('in_review');
    expect((await w.instance(created.id)).id).toBe(first.id);
    const voided = await w.revoke(created.id, again.revision);
    expect(voided.state).toBe('voided');
    expect((await w.states(created.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'hr' });
    expect((await w.instance(created.id)).status).toBe('cancelled');
    expect(await w.rejected(() => w.revoke(created.id, voided.revision))).toMatchObject({
      reason: 'PART_TIME_REQUEST_STATE_INVALID',
    });
  });

  it('删除草稿：状态置 deleted、保留快照；审批中的不能删', async () => {
    const w = await requestWorld(database().db, 'delete');
    const draft = await w.create();
    const gone = await w.remove(draft.id, 1);
    expect(gone.state).toBe('deleted');
    expect((await w.load(draft.id)).version.versionNo).toBe(1);
    const other = await w.create({ startDate: '2026-09-02' });
    const submitted = await w.send(other.id, 1);
    expect(await w.rejected(() => w.remove(other.id, submitted.revision))).toMatchObject({
      reason: 'PART_TIME_REQUEST_STATE_INVALID',
    });
  });
});

describe('状态表（§2.2）', () => {
  it('approved 与 effective 是两条事件；作废、办结、删除后不再迁移', () => {
    expect(nextPartTimeRequestState('in_review', 'approve')).toBe('approved');
    expect(nextPartTimeRequestState('approved', 'land')).toBe('effective');
    expect(nextPartTimeRequestState('approved', 'void')).toBe('voided');
    expect(nextPartTimeRequestState('in_review', 'withdraw')).toBe('draft');
    expect(nextPartTimeRequestState('rejected', 'submit')).toBe('in_review');
    expect(nextPartTimeRequestState('disapproved', 'submit')).toBeNull();
    for (const state of ['voided', 'effective', 'deleted'] as const)
      for (const action of ['submit', 'approve', 'withdraw', 'revoke', 'delete', 'land', 'void'] as const)
        expect(nextPartTimeRequestState(state, action), `${state}/${action}`).toBeNull();
    expect(nextPartTimeRequestState('in_review', 'delete')).toBeNull();
    expect(nextPartTimeRequestState('approved', 'reject')).toBeNull();
  });
});
