/**
 * AC-F476-14：Offer 批的成员删增 / 顺序变化、子项内容修改、部分行撤权后，已办读者读到办理时的原成员、原顺序、原值；
 * 不从当前成员列表重建，隐藏行不经统计暴露（响应里没有任何隐藏行计数 / 差额字段）。
 * 说明（设计 §6、DEC-057）：批单是审批「单据」，参与人看整张单的全部行；行级裁剪只针对新增的显示标签（行内部门名 / 岗位名）
 * 的来源字段权限，而不是按单个 Offer 的数据范围丢行（丢行会让审批人在真实授权器下看到空表，且与在办读现值冲突）。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { grantFieldAccess } from './AC-APV-support.js';
import { setObjectPermission } from './AC-PRM-support.js';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import {
  NAME_A1,
  NAME_A2,
  NAME_B1,
  OFFER_FIELD_CODES,
  SALARY_A,
  center,
  changeSingle,
  createOffer,
  editOffer,
  handledBatch,
  offerDetail,
  offerViewer,
  rewriteBatchMembers,
  rowsOfBatch,
} from './AC-F476-p6-support.js';

const testDb = useTestDb();
const HIDDEN_KEYS = ['hiddenRowCount', 'hiddenCount', 'sections', 'rowCount', 'totalRows'];

describe('AC-F476-14 Offer 批：冻结成员 / 顺序 / 值', () => {
  it('子项内容修改（改名、改薪资、换部门）+ 成员删增 + 顺序变化：冻结份仍是办理时的 [甲, 乙] 与原值', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-14-members');
    const s = await handledBatch(w);
    await changeSingle(w, s.a.id);
    await editOffer(w, s.b.id, { salaryAfterRegular: 9100 });
    const extra = await createOffer(w, 'ZZ_事后新增成员');
    await rewriteBatchMembers(w, s.batchId, [extra.id, s.b.id]);

    const view = await center(w, s.instanceId, w.manager.userId);
    expect(view.status, view.text).toBe(200);
    const rows = rowsOfBatch(view.body);
    expect(rows.map((row) => [row.offerId, row.name, row.baseSalary])).toEqual([
      [s.a.id, NAME_A1, SALARY_A],
      [s.b.id, NAME_A2, 7000],
    ]);
    expect(rows.map((row) => row.departmentName)).toEqual(s.atHandling.map((offer) => offer.departmentName));
    expect(view.text).not.toContain(NAME_B1);
    expect(view.text).not.toContain('ZZ_事后新增成员');
  });

  it('对照：发起人读的是现值，仍是事后的成员与顺序（D1）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-14-initiator');
    const s = await handledBatch(w);
    const extra = await createOffer(w, 'ZZ_事后新增成员');
    await rewriteBatchMembers(w, s.batchId, [extra.id, s.b.id]);
    const live = await center(w, s.instanceId, w.applicant.userId);
    expect(live.status, live.text).toBe(200);
    expect(rowsOfBatch(live.body).map((row) => row.name)).toEqual(['ZZ_事后新增成员', NAME_A2]);
  });

  it('部分行撤权（撤掉录用部门字段权）：每行的部门名与 ID 一起消失，行数、顺序、其余列不变，响应无隐藏行统计', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-14-partial');
    const viewer = await offerViewer(w, w.manager.userId);
    const batch = MODULE_OBJECTS.offerBatchApproval;
    await grantFieldAccess(viewer.world, w.manager.userId, { view: batch.fields.map((f) => f.code) }, batch);
    const s = await handledBatch(w, 'real');
    const response = await setObjectPermission(
      viewer.world,
      viewer.profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: OFFER_FIELD_CODES.map((fieldCode) => ({ fieldCode, view: fieldCode !== 'departmentId', edit: false })),
        buttons: [],
      },
      MODULE_OBJECTS.offer.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);

    const view = await center(w, s.instanceId, w.manager.userId, true);
    expect(view.status, view.text).toBe(200);
    const rows = rowsOfBatch(view.body);
    expect(rows.map((row) => row.name)).toEqual([NAME_A1, NAME_A2]);
    for (const row of rows) {
      expect(row).not.toHaveProperty('departmentName');
      expect(row.departmentId ?? null).toBeNull();
    }
    expect(view.text).not.toContain(s.atHandling[0]!.departmentName as string);
    for (const key of HIDDEN_KEYS) expect(view.body, key).not.toHaveProperty(key);
    expect(view.body.form.values, 'values').not.toHaveProperty('hiddenRowCount');
  });

  it('集合办理不扩散成单个读权：批的已办读者在真实授权器下读不了成员 Offer 详情', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-14-no-spread');
    const batch = MODULE_OBJECTS.offerBatchApproval;
    await offerViewer(
      w,
      w.manager.userId,
      batch.fields.map((f) => f.code),
      batch,
    ); // 只授批表单，不授 Offer 对象
    const s = await handledBatch(w, 'real');
    const single = await offerDetail(w, s.a.id, w.manager.userId, true);
    expect([403, 404]).toContain(single.status);
    expect(single.text).not.toContain(NAME_A1);
  });

  it('边界：单成员批与特殊字符备注，冻结读取不报错', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-14-edge');
    const only = await createOffer(w, 'ZZ_单成员<&"\'>');
    const batch = await w.json<{ id: string }>(
      await w.batchRaw({ offerIds: [only.id], remark: 'ZZ_备注\n含换行' }),
      201,
    );
    await w.decide(await w.instance(batch.id), w.manager, 'disagree');
    const view = await center(w, (await w.instance(batch.id)).id, w.manager.userId);
    expect(view.status, view.text).toBe(200);
    expect(rowsOfBatch(view.body).map((row) => row.name)).toEqual(['ZZ_单成员<&"\'>']);
  });
});
