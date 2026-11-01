import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { expectError } from './AC-OA-head-support.js';
import { itemsWorld, reasons, rename, stop } from './AC-OA-items-support.js';

const testDb = useTestDb();
const linkage = { transferOldHeadSubordinates: false, adjustNewHeadManager: false };

describe('AC-OA-02 新负责人须在本组织（DEC-644 A-12）', () => {
  it('新负责人只在别的组织任职 → 校验 HEAD_NOT_IN_ORG 原文；在本组织任职 → 通过', async () => {
    const w = await itemsWorld(testDb().db, 'oa02');
    const outside = await w.person('外部负责人', w.b);
    const inside = await w.person('内部负责人', w.a);
    const view = await w.created();
    const created = await w.item(view.id, {
      entry: 'detail.change',
      adjustType: 2,
      targetOrgId: w.a,
      personInChargeId: outside.employeeId,
      ...linkage,
    });
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        section: 'org',
        itemId: created.items[0]!.id,
        reason: 'ORG_ADJUSTMENT_HEAD_NOT_IN_ORG',
        message: '请在本单为新负责人添加调动或兼职明细',
      }),
    );
    const patched = await w.patchItem(view.id, created.items[0]!.id, { personInChargeId: inside.employeeId });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.checked(view.id)).valid).toBe(true);
  });

  it('负责人变化：两项联动必填；任一为“是” → 400 HEAD_LINKAGE_NOT_AVAILABLE；负责人未变不许填', async () => {
    const w = await itemsWorld(testDb().db, 'oa02');
    const inside = await w.person('内部负责人', w.a);
    const view = await w.created();
    const base = { entry: 'detail.change', adjustType: 2, targetOrgId: w.a, personInChargeId: inside.employeeId };
    await expectError(await w.addItem(view.id, base), 400, 'VALIDATION_FAILED');
    await expectError(
      await w.addItem(view.id, { ...base, transferOldHeadSubordinates: false }),
      400,
      'VALIDATION_FAILED',
    );
    for (const flag of ['transferOldHeadSubordinates', 'adjustNewHeadManager'])
      await expectError(
        await w.addItem(view.id, { ...base, ...linkage, [flag]: true }),
        400,
        'VALIDATION_FAILED',
        'ORG_ADJUSTMENT_HEAD_LINKAGE_NOT_AVAILABLE',
      );
    await expectError(await w.addItem(view.id, { ...rename(w.a), ...linkage }), 400, 'VALIDATION_FAILED');
    expect(await w.rows(view.id)).toEqual([]);
  });
});

describe('11d / 11e 之前的关口（§8.4、§5.8）', () => {
  it('同步编制 / 编制处理方式 / 转移数量 → 400 SYNC_NOT_AVAILABLE；未开放字段 → 400', async () => {
    const w = await itemsWorld(testDb().db, 'oagate');
    const view = await w.created();
    for (const extra of [
      { syncEstablishment: true },
      { deactivationEstablishmentMode: 1 },
      { establishmentTransferAmount: 1 },
    ])
      await expectError(
        await w.addItem(view.id, stop(w.a, extra)),
        400,
        'VALIDATION_FAILED',
        'ORG_ADJUSTMENT_ESTABLISHMENT_SYNC_NOT_AVAILABLE',
      );
    await expectError(await w.addItem(view.id, stop(w.a, { establishment: 3 })), 400, 'VALIDATION_FAILED');
    expect((await w.addItem(view.id, stop(w.a, { syncEstablishment: false }))).status).toBe(201);
  });

  it('停用整支有编制 → 校验报 END_NOT_AVAILABLE（只报一次、带组织）', async () => {
    const w = await itemsWorld(testDb().db, 'oagate');
    const view = await w.created();
    await w.capacity(w.a);
    await w.item(view.id, stop(w.a));
    const result = await w.checked(view.id);
    expect(reasons(result).filter((r) => r === 'ORG_ADJUSTMENT_ESTABLISHMENT_END_NOT_AVAILABLE')).toHaveLength(1);
    expect(result.errors).toContainEqual(expect.objectContaining({ orgId: w.a }));
  });
});
