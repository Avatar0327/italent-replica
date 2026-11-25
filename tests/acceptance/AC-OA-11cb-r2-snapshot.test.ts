/**
 * BE-11c-b 第 2 轮 P1-4（R2-T08 §4.5）：调动分区的审批快照要完整反映“将要改什么”与“改之前是什么”。
 *  - 显式清空虚线经理也是变化字段（随直线经理编码），看不到该字段的审批人要被盲审拦下；
 *  - 合同变更逐行编码的原值 = 合同现值（§4.5 values / originals 的对称）；
 *  - 联动白名单：快照不覆盖的联动（兼职终止、电子签、交接、社保调整）本片入口一律拒绝，不能存了却不进快照。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { contractChangeFieldCode } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { expectError } from './AC-OA-head-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { orgAdjustmentSnapshot } from '../../apps/api/src/modules/org-adjustment/snapshot.js';

const testDb = useTestDb();

async function setup(label: string) {
  const w = await transferWorld(testDb().db, label);
  const mover = await w.staff(w.a);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  return { w, mover, view };
}

describe('P1-4 显式清空虚线经理进入快照并触发盲审', () => {
  it('快照里 transferItems.directManagerId 有这一行（值带虚线经理清空），不因直线经理为空被跳过', async () => {
    const { w, mover, view } = await setup('r2-dotted-snapshot');
    const itemId = await w.seed(view.id, mover, { dottedManagerId: null });

    const snapshot = await w.inTenant((tx) => orgAdjustmentSnapshot(tx, w.tenant.id, view.id));

    expect(snapshot.changedFields).toContain('transferItems.directManagerId');
    expect(snapshot.values['transferItems.directManagerId']).toEqual([expect.objectContaining({ itemId })]);
  });

  it('审批人看不到虚线 / 直线经理字段：手动同意被盲审拦下（403 APPROVAL_BLIND_REVIEW），单据仍审批中', async () => {
    const { w, mover, view } = await setup('r2-dotted-blind');
    await w.seed(view.id, mover, { dottedManagerId: null });
    await w.submitted(view.id);
    w.access.hiddenByUser.set(w.hrbp.userId, new Set(['transferItems.directManagerId']));

    await expectError(await w.act(view.id, w.hrbp, 'approve'), 403, 'FORBIDDEN', 'APPROVAL_BLIND_REVIEW');

    expect(await w.state(view.id)).toMatchObject({ approval: 1 });
  });
});

describe('P1-4 合同变更逐行编码带原值', () => {
  it('快照 originals 里每个被改的合同字段 = 合同现值；目标合同 ID 不重复登记原值', async () => {
    const { w, mover, view } = await setup('r2-contract-originals');
    const contractId = await w.contractOf(mover);
    const itemId = await w.seed(view.id, mover, {
      linkageInput: {
        contract: { targetId: contractId, fields: { endDate: '2029-10-09', signingDate: '2026-10-02' } },
      },
    });
    const [current] = await w.inTenant(async (tx) =>
      resultRows<{ end: string; signing: string }>(
        await tx.execute(sql`SELECT end_date::text AS end, signing_date::text AS signing FROM contract_records
          WHERE id = ${contractId}`),
      ),
    );

    const snapshot = await w.inTenant((tx) => orgAdjustmentSnapshot(tx, w.tenant.id, view.id));

    const originals = snapshot.originals ?? {};
    expect(originals[contractChangeFieldCode(itemId, 'endDate')]).toEqual([{ itemId, value: current!.end }]);
    expect(originals[contractChangeFieldCode(itemId, 'signingDate')]).toEqual([{ itemId, value: current!.signing }]);
    expect(originals).not.toHaveProperty(contractChangeFieldCode(itemId, 'targetId'));
  });
});

describe('P1-4 联动白名单：快照不覆盖的联动本片拒绝', () => {
  const random = () => randomUUID();
  it.each([
    ['partTimes', () => ({ partTimes: [{ recordId: random() }] })],
    ['handover', () => ({ handover: { handoverPersonId: null } })],
    ['esign', () => ({ esign: { templateIds: [random()] } })],
    ['adjustedInsurancePlanId', () => ({ adjustedInsurancePlanId: random() })],
  ])('新增带 %s → 400 ORG_ADJUSTMENT_LINKAGE_UNSUPPORTED，不留明细', async (key, linkage) => {
    const { w, mover, view } = await setup(`r2-linkage-${key}`);

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage: linkage() }));

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_LINKAGE_UNSUPPORTED');
    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('修改已有行时塞进不支持的联动同样 400，行原样保留', async () => {
    const { w, mover, view } = await setup('r2-linkage-patch');
    const added = await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }));

    const res = await w.patchTransfer(view.id, added.items[0]!.id, {
      linkage: { partTimes: [{ recordId: random() }] },
    });

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_LINKAGE_UNSUPPORTED');
    expect((await w.transferRows(view.id))[0]!.linkage).toBeNull();
  });

  it('空值与受支持的联动照常通过（partTimes 为空数组、调薪、试岗）', async () => {
    const { w, mover, view } = await setup('r2-linkage-ok');

    await w.transfer(
      view.id,
      w.transferBody(mover, { orgId: w.b }, { linkage: { partTimes: [], adjustSalary: true } }),
    );

    expect(await w.transferRows(view.id)).toHaveLength(1);
  });
});
