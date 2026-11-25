/**
 * BE-11c-b 第 2 轮 P2-2（R2-T08 §5.2、§8.2）：新负责人须在本组织的判定叠加本单调动明细。
 *  - 本单把他调入该组织（含本单新增组织）算在；移除调入后仍拒绝；本单把他调出该组织算不在；
 *  - 自动生成的两个联动选项（原下属转交 / 新负责人经理调整）本片仍 400。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { expectError } from './AC-OA-head-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const noLinkage = { transferOldHeadSubordinates: false, adjustNewHeadManager: false };
const HEAD_NOT_IN_ORG = 'ORG_ADJUSTMENT_HEAD_NOT_IN_ORG';

describe('P2-2 新负责人在本单调入本组织：提交可过；移除调入后仍拒绝', () => {
  async function headChange(label: string) {
    const w = await transferWorld(testDb().db, label);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const outsider = await w.person('外部负责人', w.a); // 现在 A 下，要当 B 的负责人
    await w.item(view.id, {
      entry: 'detail.change',
      adjustType: 2,
      targetOrgId: w.b,
      personInChargeId: outsider.employeeId,
      ...noLinkage,
    });
    return { w, view, outsider };
  }

  it('既有组织：本单把他调入 B → 校验通过并能提交；删掉调入行 → 提交 400 HEAD_NOT_IN_ORG', async () => {
    const { w, view, outsider } = await headChange('r2-head-in');
    expect((await w.checked(view.id)).errors.map((e) => e.reason)).toContain(HEAD_NOT_IN_ORG);

    const moved = await w.transfer(view.id, w.transferBody(outsider.employeeId, { orgId: w.b }));
    expect((await w.checked(view.id)).errors).toEqual([]);
    await w.submitted(view.id);
    expect(moved.items).toHaveLength(1);
  });

  it('移除调入行后仍报 HEAD_NOT_IN_ORG（提交 400）', async () => {
    const { w, view, outsider } = await headChange('r2-head-removed');
    const moved = await w.transfer(view.id, w.transferBody(outsider.employeeId, { orgId: w.b }));
    expect((await w.checked(view.id)).errors).toEqual([]);

    expect((await w.deleteTransfer(view.id, moved.items[0]!.id)).status).toBe(200);

    expect((await w.checked(view.id)).errors.map((e) => e.reason)).toContain(HEAD_NOT_IN_ORG);
    await expectError(await w.submit(view.id), 400, 'VALIDATION_FAILED');
  });

  it('本单把他调离该组织：即使他现在就在 B，也算不在（调出优先于库内任职）', async () => {
    const w = await transferWorld(testDb().db, 'r2-head-out');
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const inside = await w.person('B下负责人', w.b);
    await w.item(view.id, {
      entry: 'detail.change',
      adjustType: 2,
      targetOrgId: w.b,
      personInChargeId: inside.employeeId,
      ...noLinkage,
    });
    expect((await w.checked(view.id)).errors).toEqual([]);

    await w.transfer(view.id, w.transferBody(inside.employeeId, { orgId: w.a }));

    expect((await w.checked(view.id)).errors.map((e) => e.reason)).toContain(HEAD_NOT_IN_ORG);
  });

  it('新增组织：本单把他调入该新增组织 → 通过；移除后拒绝', async () => {
    const w = await transferWorld(testDb().db, 'r2-head-new-org');
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const outsider = await w.person('新组织负责人', w.a);
    const created = await w.item(
      view.id,
      newOrg(w.b, { name: `ZZ_新组织${uniqueSuffix()}`, personInChargeId: outsider.employeeId, ...noLinkage }),
    );
    expect((await w.checked(view.id)).errors.map((e) => e.reason)).toContain(HEAD_NOT_IN_ORG);

    const moved = await w.transfer(view.id, w.transferBody(outsider.employeeId, { itemId: created.items[0]!.id }));
    expect((await w.checked(view.id)).errors).toEqual([]);

    await w.deleteTransfer(view.id, moved.items[0]!.id);
    expect((await w.checked(view.id)).errors.map((e) => e.reason)).toContain(HEAD_NOT_IN_ORG);
  });

  it.each(['transferOldHeadSubordinates', 'adjustNewHeadManager'])(
    '自动生成联动选项 %s = true 本片仍 400 ORG_ADJUSTMENT_HEAD_LINKAGE_NOT_AVAILABLE',
    async (key) => {
      const { w, view, outsider } = await headChange(`r2-head-linkage-${key}`);
      await w.transfer(view.id, w.transferBody(outsider.employeeId, { orgId: w.b }));
      const rows = (await w.rows(view.id)).filter((row) => row.target_org_id === w.b);

      const res = await w.patchItem(view.id, rows[0]!.id, { [key]: true });

      await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_HEAD_LINKAGE_NOT_AVAILABLE');
    },
  );
});
