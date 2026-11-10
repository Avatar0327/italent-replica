/**
 * AC-F476-07（P6 部分）：冻结后撤字段权 / 新增字段权，Offer 单与 Offer 批的已办读取按「办理时上限 ∩ 节点表单 ∩ 当前权限」披露。
 * 真实授权器：办理走真实授权器，办理人的 Offer 字段权限即办理上限；之后用同一身份改权限。
 * - 撤权：名称（departmentName 等标签）、原值、changedFields、错误信封、导出（审批历史）同时消失，标签与 ID 一起裁；
 * - 新增权限不超办理上限：办理时不可见的字段，事后授权也不补露进旧办理份；
 * - 「frozen 原样返回或仅裁顶层必失败」：值、标签、批的行内列都要被裁；
 * - 历史份不再按当前数据范围裁行（DEC-834④）：本片的 Offer 数据范围夹具见 AC-F476-14-p6。
 * 本片覆盖 offer、offer_batch；留给 P2 / P5（已做）：组织调整、合同等。附件权：Offer / Offer 批没有附件字段，
 * 附件摘要沿用审批实例附件路径的同一披露集（P1 已覆盖），本片无附件可撤，在结果文件里标「不适用」。
 * 盲审（DEC-058）使办理人必须看得到本单全部非空变化字段，所以办理上限里缺的只可能是办理时为空的字段、
 * 或批的行内 Offer 字段（批表单字段权与 Offer 对象字段权是两套授权），下面两个“新增权限”用例据此构造。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { grantFieldAccess } from './AC-APV-support.js';
import { setObjectPermission } from './AC-PRM-support.js';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import {
  APPROVAL,
  NAME_A1,
  NAME_A2,
  OFFER_FIELD_CODES,
  PLACE_A,
  PLACE_B,
  center,
  changeSingle,
  editOffer,
  handledBatch,
  handledSingle,
  offerDetail,
  offerViewer,
  realApi,
  rowsOfBatch,
  stripExt,
} from './AC-F476-p6-support.js';

const testDb = useTestDb();
const without = (...hidden: string[]) => OFFER_FIELD_CODES.filter((code) => !hidden.includes(code));
const OFFER = MODULE_OBJECTS.offer.code;

async function setView(
  viewer: Awaited<ReturnType<typeof offerViewer>>,
  view: readonly string[],
  objectCode: string = OFFER,
  fields = OFFER_FIELD_CODES,
) {
  const response = await setObjectPermission(
    viewer.world,
    viewer.profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: fields.map((fieldCode) => ({ fieldCode, view: view.includes(fieldCode), edit: false })),
      buttons: [],
    },
    objectCode,
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('AC-F476-07 offer：撤字段权后已办读取同时裁掉值与名称', () => {
  it('办理后撤掉录用部门与直接上级的查看权：审批中心与单 Offer 详情都不再含其 ID、名称、changedFields 项', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-07-revoke');
    const viewer = await offerViewer(w, w.head.userId);
    const s = await handledSingle(w, 'real');
    await changeSingle(w, s.offer.id);

    const before = await center(w, s.instanceId, w.head.userId, true);
    expect(before.status, before.text).toBe(200);
    expect(before.body.form.values).toMatchObject({ departmentName: s.atHandling.departmentName });

    await setView(viewer, without('departmentId', 'directManagerId'));
    const viaCenter = await center(w, s.instanceId, w.head.userId, true);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    const values = viaCenter.body.form.values as Record<string, unknown>;
    for (const key of ['departmentId', 'departmentName', 'departmentFullName', 'directManagerId', 'directManagerName'])
      expect(values, key).not.toHaveProperty(key);
    expect(values).toMatchObject({ workPlace: PLACE_A });
    expect(JSON.stringify(viaCenter.body.changedFields ?? [])).not.toContain('departmentId');
    expect(viaCenter.text).not.toContain(s.atHandling.departmentName as string);

    const viaOffer = await offerDetail(w, s.offer.id, w.head.userId, true);
    expect(viaOffer.status, viaOffer.text).toBe(200);
    for (const key of ['departmentId', 'departmentName', 'directManagerId', 'directManagerName'])
      expect(viaOffer.body, key).not.toHaveProperty(key);
    expect(viaOffer.body).toMatchObject({ workPlace: PLACE_A });
    expect(viaOffer.text).not.toContain(PLACE_B);
  });

  it('撤权后审批历史（任务与日志，导出口径）也不泄露被撤字段的名称', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-07-history');
    const viewer = await offerViewer(w, w.head.userId);
    const s = await handledSingle(w, 'real');
    await setView(viewer, without('departmentId'));
    for (const path of ['tasks', 'logs']) {
      const response = await realApi(w).request(
        'GET',
        `${APPROVAL}/instances/${s.instanceId}/${path}`,
        w.as(w.head.userId),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.text(), path).not.toContain(s.atHandling.departmentName as string);
    }
  });

  it('办理时为空且不可见的字段，事后补值并授予查看权，也不补露进旧办理份（不超办理上限）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-07-expand');
    const viewer = await offerViewer(w, w.head.userId, without('costCenter'));
    const s = await handledSingle(w, 'real');
    await editOffer(w, s.offer.id, { costCenter: 'ZZ_事后成本中心' });
    await setView(viewer, OFFER_FIELD_CODES); // 事后放宽到全部字段
    const viaCenter = await center(w, s.instanceId, w.head.userId, true);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    expect(viaCenter.body.form.values).toMatchObject({ workPlace: PLACE_A });
    expect(viaCenter.text).not.toContain('ZZ_事后成本中心');
    const viaOffer = await offerDetail(w, s.offer.id, w.head.userId, true);
    expect(viaOffer.status, viaOffer.text).toBe(200);
    expect(viaOffer.body).toMatchObject({ workPlace: PLACE_A });
    expect(viaOffer.text).not.toContain('ZZ_事后成本中心');
  });

  it('错误信封不回显被撤字段：缺份 503 的响应体不含办理时的地点 / 部门名', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-07-error');
    const viewer = await offerViewer(w, w.head.userId);
    const s = await handledSingle(w, 'real');
    await setView(viewer, without('workPlace', 'departmentId'));
    await stripExt(w, w.head.userId);
    const viaCenter = await center(w, s.instanceId, w.head.userId, true);
    expect(viaCenter.status, viaCenter.text).toBe(503);
    expect(viaCenter.text).not.toContain(PLACE_A);
    expect(viaCenter.text).not.toContain(s.atHandling.departmentName as string);
  });
});

describe('AC-F476-07 offer_batch：撤批表单字段权与子表列', () => {
  const BATCH = MODULE_OBJECTS.offerBatchApproval;

  it('办理后撤掉批的 offers 字段：审批中心不再含行（姓名、行内部门名），不是只裁顶层 key', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-07-batch-revoke');
    const batchFields = BATCH.fields.map((field) => field.code);
    const viewer = await offerViewer(w, w.manager.userId, batchFields, BATCH);
    const s = await handledBatch(w, 'real');
    const full = await center(w, s.instanceId, w.manager.userId, true);
    expect(full.status, full.text).toBe(200);
    expect(rowsOfBatch(full.body)).toHaveLength(2);

    await setView(
      viewer,
      batchFields.filter((code) => code !== 'offers'),
      BATCH.code,
      batchFields,
    );
    const revoked = await center(w, s.instanceId, w.manager.userId, true);
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body.form.values).not.toHaveProperty('offers');
    expect(revoked.text).not.toContain(s.atHandling[0]!.departmentName as string);
    expect(revoked.text).not.toContain('合成实习生');
  });

  // 撤掉 offers 后字段裁剪先去掉整个子表：份的完整性（形状 + 逐行标签条目）仍须在任何裁剪 / 提前返回之前校验
  // （R2 / R3 P2-3）。offers 可见 × 三种缺份方式见 AC-F476-08-p6。
  const DAMAGES = [
    ['ext', '缺整个扩展'],
    ['firstBatchRow', '缺一行标签条目'],
    ['badCeiling', '行内列上限形状错'],
  ] as const;
  for (const [damage, label] of DAMAGES)
    it(`撤掉批的 offers 字段 × 办理份${label}：仍 503，错误信封不含行姓名、备注、部门名（P2-3）`, async () => {
      const w = await offerApprovalWorld(testDb().db, `p6-07-batch-revoke-${damage}`);
      const batchFields = BATCH.fields.map((field) => field.code);
      const viewer = await offerViewer(w, w.manager.userId, batchFields, BATCH);
      const s = await handledBatch(w, 'real');
      await setView(
        viewer,
        batchFields.filter((code) => code !== 'offers'),
        BATCH.code,
        batchFields,
      );
      await stripExt(w, w.manager.userId, damage);
      const viaCenter = await center(w, s.instanceId, w.manager.userId, true);
      expect(viaCenter.status, viaCenter.text).toBe(503);
      expect(viaCenter.body.error).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        details: { reason: 'APPROVAL_HANDLING_CONTENT_MISSING' },
      });
      for (const leaked of [NAME_A1, NAME_A2, 'ZZ_批备注', s.atHandling[0]!.departmentName as string])
        expect(viaCenter.text, leaked).not.toContain(leaked);
    });

  it('办理时看不到行内「录用部门」（Offer 对象字段权），事后授权也补不进旧批份的行', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-07-batch-expand');
    const batchFields = BATCH.fields.map((field) => field.code);
    const viewer = await offerViewer(w, w.manager.userId, without('departmentId'));
    await grantFieldAccess(viewer.world, w.manager.userId, { view: batchFields }, BATCH);
    const s = await handledBatch(w, 'real');
    await setView(viewer, OFFER_FIELD_CODES); // 事后放宽 Offer 对象的全部字段
    const viaCenter = await center(w, s.instanceId, w.manager.userId, true);
    expect(viaCenter.status, viaCenter.text).toBe(200);
    const rows = rowsOfBatch(viaCenter.body);
    expect(rows.map((row) => row.name)).toEqual([NAME_A1, NAME_A2]);
    for (const row of rows) {
      expect(row).not.toHaveProperty('departmentName');
      expect(row.departmentId ?? null).toBeNull();
    }
    expect(viaCenter.text).not.toContain(s.atHandling[0]!.departmentName as string);
  });
});
