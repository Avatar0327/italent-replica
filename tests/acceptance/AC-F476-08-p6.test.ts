/**
 * AC-F476-08（P6 部分）：Offer 单（offer）与 Offer 批（offer_batch）两个真实类型，
 * 办理 → 事后修改 / 删除 → 经「审批中心」与「单 Offer 详情」两条不同接口读取，都是办理时的那一份。
 * 本片覆盖：offer、offer_batch。留给 P4、P7～P9：employment / personnel_change / contract / part_time /
 * idp / probation_assessment / retirement_intention / exit_handover（P2 / P5 已做：org_adjustment 等）。
 * 缺份（扩展缺失）一律 503，不回退现值（DEC-807）；「不同意 / 驳回重开」后仍按全部审批实例定位旧份（P8 评审 P2-2）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import {
  NAME_A1,
  NAME_A2,
  NAME_B1,
  PLACE_A,
  PLACE_B,
  SALARY_A,
  center,
  changeSingle,
  copiesFor,
  createOffer,
  editOffer,
  handledBatch,
  handledSingle,
  instanceIdsOf,
  laterInstances,
  offerDetail,
  renameOrg,
  rewriteBatchMembers,
  rowsOfBatch,
  stripExt,
} from './AC-F476-p6-support.js';

const testDb = useTestDb();

describe('AC-F476-08 offer（Offer 单）：办理 → 修改 → 两路径读取', () => {
  it('部门负责人驳回后申请人改地点 / 薪资 / 姓名 / 录用部门：审批中心与单 Offer 详情都读到办理时的值与名称', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-single');
    const s = await handledSingle(w);
    expect(await copiesFor(w, s.instanceId)).toHaveLength(1);
    await changeSingle(w, s.offer.id);

    const viaCenter = await center(w, s.instanceId, w.head.userId);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    expect(viaCenter.body.contentView).toMatchObject({ mode: 'frozen' });
    expect(viaCenter.body.form.values).toMatchObject({
      name: NAME_A1,
      workPlace: PLACE_A,
      salaryAfterRegular: SALARY_A,
      departmentName: s.atHandling.departmentName,
      directManagerName: s.atHandling.directManagerName,
    });

    const viaOffer = await offerDetail(w, s.offer.id, w.head.userId);
    expect(viaOffer.status, viaOffer.text).toBe(200);
    expect(viaOffer.body).toMatchObject({
      id: s.offer.id,
      name: NAME_A1,
      workPlace: PLACE_A,
      departmentName: s.atHandling.departmentName,
      contentView: { mode: 'frozen' },
    });
    expect(viaOffer.text).not.toContain(PLACE_B);
    expect(viaOffer.text).not.toContain(NAME_B1);
  });

  it('办理后录用部门改名：两条路径都不出现当前名称（审批中心不按现名补 departmentIdName）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-renamed');
    const s = await handledSingle(w);
    const renamed = 'ZZ_改名后的录用部门';
    await renameOrg(w, s.atHandling.departmentId as string, renamed);
    expect((await w.get(s.offer.id)).departmentName, '夹具：现值已是新名称').toBe(renamed);

    const viaCenter = await center(w, s.instanceId, w.head.userId);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    expect(viaCenter.body.form.values.departmentName).toBe(s.atHandling.departmentName);
    expect(viaCenter.text).not.toContain(renamed);
    const viaOffer = await offerDetail(w, s.offer.id, w.head.userId);
    expect(viaOffer.status, viaOffer.text).toBe(200);
    expect(viaOffer.body.departmentName).toBe(s.atHandling.departmentName);
    expect(viaOffer.text).not.toContain(renamed);
  });

  it('对照：发起人（申请人）不是已办读者，读到的仍是现值（D1，DEC-801）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-initiator');
    const s = await handledSingle(w);
    await changeSingle(w, s.offer.id);
    const live = await offerDetail(w, s.offer.id, w.applicant.userId);
    expect(live.body).toMatchObject({ workPlace: PLACE_B, name: NAME_B1 });
    expect(live.body.contentView).toBeUndefined();
  });

  it('Offer 被删除后：已办读者两条路径仍读到办理时的整份，不退化成空对象', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-deleted');
    const s = await handledSingle(w);
    const current = await w.get(s.offer.id);
    const removed = await w.request(w.applicant.userId, 'DELETE', `/api/tenant/offers/${s.offer.id}`, {
      ifMatch: current.revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);

    const viaCenter = await center(w, s.instanceId, w.head.userId);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    expect(viaCenter.body.form.values).toMatchObject({ name: NAME_A1, workPlace: PLACE_A });
    const viaOffer = await offerDetail(w, s.offer.id, w.head.userId);
    expect(viaOffer.status, viaOffer.text).toBe(200);
    expect(viaOffer.body).toMatchObject({ id: s.offer.id, name: NAME_A1, workPlace: PLACE_A });
  });

  it('不同意后重开：旧办理份仍由单 Offer 详情定位（候选来自全部审批实例，不是 latestInstanceOf）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-instances');
    const offer = await createOffer(w, NAME_A1);
    await w.json(await w.submitRaw(offer));
    const first = await w.instance(offer.id);
    await w.decide(first, w.head, 'disagree'); // 第一轮：负责人不同意（办理份 A）
    await editOffer(w, offer.id, { workPlace: PLACE_B });
    await w.json(await w.submitRaw(await w.get(offer.id))); // 重新发起：沿用原实例或新建实例（DEC-103）
    const ids = await instanceIdsOf(w, offer.id);
    const reused = ids.length === 1; // 沿用原实例（DEC-103）或新建实例，两种实现都要读对

    // 负责人在新一轮有待办 → 单 Offer 详情读现值（D6），不得 500
    const viaOffer = await offerDetail(w, offer.id, w.head.userId);
    expect(viaOffer.status, viaOffer.text).toBe(200);
    expect(viaOffer.body.workPlace).toBe(PLACE_B);
    const old = await center(w, first.id, w.head.userId);
    expect(old.status, old.text).toBe(200);
    // 新建了实例：旧实例上没有待办，负责人读自己在旧实例的办理份（A）；沿用原实例：待办在手读现值
    expect(old.body.form.values.workPlace).toBe(reused ? PLACE_B : PLACE_A);
    expect((await copiesFor(w, first.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('办理所在实例之后又有 200 个实例：单 Offer 详情仍按全部实例定位本人的办理份，不回退现值（评审 P2-1）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-201st');
    const s = await handledSingle(w);
    await laterInstances(w, s.instanceId, 200); // 办理份落在第 201 个实例上；本人在后来的实例上没有待办
    await changeSingle(w, s.offer.id);

    const viaOffer = await offerDetail(w, s.offer.id, w.head.userId);
    expect(viaOffer.status, viaOffer.text).toBe(200);
    expect(viaOffer.body).toMatchObject({ name: NAME_A1, workPlace: PLACE_A, contentView: { mode: 'frozen' } });
    expect(viaOffer.text).not.toContain(PLACE_B);
    const viaCenter = await center(w, s.instanceId, w.head.userId);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    expect(viaCenter.body.contentView).toMatchObject({ mode: 'frozen' });
    expect(viaCenter.body.form.values).toMatchObject({ name: NAME_A1, workPlace: PLACE_A });
  });

  it('缺份（办理份被去掉扩展）：两条路径都 503，不回退现值', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-missing');
    const s = await handledSingle(w);
    await copiesFor(w, s.instanceId);
    await stripExt(w, w.head.userId);
    const viaCenter = await center(w, s.instanceId, w.head.userId);
    expect(viaCenter.status, viaCenter.text).toBe(503);
    expect(viaCenter.text).not.toContain(PLACE_A);
    const viaOffer = await offerDetail(w, s.offer.id, w.head.userId);
    expect(viaOffer.status, viaOffer.text).toBe(503);
  });
});

describe('AC-F476-08 offer_batch（Offer 批）：办理 → 修改 → 两路径读取', () => {
  it('直接上级不同意后子项改名 / 换部门：审批中心的批表单与单 Offer 详情都读办理时的行与名称', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-batch');
    const s = await handledBatch(w);
    const moved = await changeSingle(w, s.a.id);
    expect(moved).toBeTruthy();

    const viaCenter = await center(w, s.instanceId, w.manager.userId);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    const rows = rowsOfBatch(viaCenter.body);
    expect(rows.map((row) => row.name)).toEqual([NAME_A1, NAME_A2]);
    expect(rows.map((row) => row.departmentName)).toEqual([
      s.atHandling[0]!.departmentName,
      s.atHandling[1]!.departmentName,
    ]);
    expect(viaCenter.text).not.toContain(NAME_B1);
    expect(viaCenter.body.form.values).toMatchObject({ remark: 'ZZ_批备注' });
    expect((await copiesFor(w, s.instanceId)).map((c) => c.business_type)).toEqual(['offer_batch']);

    // 单 Offer 详情路径：批的已办读者不因集合办理获得单 Offer 读权（集合不扩散成单个读权）
    const single = await offerDetail(w, s.a.id, w.manager.userId, true);
    expect([403, 404]).toContain(single.status);
  });

  it('成员删增 / 顺序变化后：审批中心仍读办理时的成员与顺序，不从当前成员列表重建', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-batch-members');
    const s = await handledBatch(w);
    const extra = await createOffer(w, 'ZZ_事后新增成员');
    await rewriteBatchMembers(w, s.batchId, [extra.id, s.b.id]); // 删 a、增 extra、b 提前
    const viaCenter = await center(w, s.instanceId, w.manager.userId);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    expect(rowsOfBatch(viaCenter.body).map((row) => row.name)).toEqual([NAME_A1, NAME_A2]);
    expect(viaCenter.text).not.toContain('ZZ_事后新增成员');
  });

  it('缺份：批的已办读者读审批中心 503，不回退当前成员', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-batch-missing');
    const s = await handledBatch(w);
    await copiesFor(w, s.instanceId);
    await stripExt(w, w.manager.userId);
    const viaCenter = await center(w, s.instanceId, w.manager.userId);
    expect(viaCenter.status, viaCenter.text).toBe(503);
    expect(viaCenter.text).not.toContain(PLACE_B);
  });

  it('份残缺（批扩展少了一行的标签条目）：503，不以空标签冒充办理时的行（R2 P2-3 同类）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-batch-row-missing');
    const s = await handledBatch(w);
    await stripExt(w, w.manager.userId, 'firstBatchRow');
    const viaCenter = await center(w, s.instanceId, w.manager.userId);
    expect(viaCenter.status, viaCenter.text).toBe(503);
    expect(viaCenter.text).not.toContain(NAME_A1);
    expect(viaCenter.text).not.toContain(s.atHandling[1]!.departmentName as string);
  });

  it('份残缺（批扩展的行内列上限不是数组）：503，不按“无上限”放开行内列', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-08-batch-ceiling-bad');
    const s = await handledBatch(w);
    await stripExt(w, w.manager.userId, 'badCeiling');
    const viaCenter = await center(w, s.instanceId, w.manager.userId);
    expect(viaCenter.status, viaCenter.text).toBe(503);
    expect(viaCenter.text).not.toContain(NAME_A1);
    expect(viaCenter.text).not.toContain('ZZ_批备注');
  });
});
