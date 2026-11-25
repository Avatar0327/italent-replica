/**
 * BE-11c-b 联动与授权（R2-T08 §6.3 / §4.5）：
 * AC-OA-32 跨对象写授权（改写职责联动字段 / 合同变更的新建、修改、删除、置 false 都按当前权限，被拒不留明细）；
 * AC-OA-09 调动勾选变更合同 → 执行后新合同版本 + 合同变更记录；
 * AC-OA-27（合同部分）逐行编码 `transferItems.<itemId>.contractChange.<field>` 的披露与盲审；
 * 以及提交时按当前权限复核已存明细。
 */
import { runEmploymentActivations } from '@italent/api';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { bodyOf, expectError, only } from './AC-OA-head-support.js';
import { oaNodes } from './AC-OA-approval-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();

async function setup(label: string) {
  const w = await transferWorld(testDb().db, label);
  const mover = await w.staff(w.a);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  return { w, mover, view };
}

describe('AC-OA-32 跨对象写授权', () => {
  it.each([
    ['调薪联动字段', { adjustSalary: true }, 'adjustSalary'],
    ['试岗联动字段', { onTrial: { startDate: '2026-11-01', months: 3 } }, 'onTrialStartDate'],
  ])('新建：没有%s的编辑权 → 403，不留明细', async (_name, linkage, field) => {
    const { w, mover, view } = await setup(`oa32-create-${field}`);
    w.access.deniedFields.add(field);

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage }));

    await expectError(res, 403, 'FORBIDDEN');
    expect(await w.transferRows(view.id)).toEqual([]);
    expect(await w.transferAudits(view.id)).toEqual([]);
  });

  it('修改置 false 与删除：同样要联动字段编辑权，被拒后行与联动原样保留', async () => {
    const { w, mover, view } = await setup('oa32-modify-delete');
    const added = await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage: { adjustSalary: true } }));
    const itemId = added.items[0]!.id;
    w.access.deniedFields.add('adjustSalary');

    await expectError(await w.patchTransfer(view.id, itemId, { linkage: { adjustSalary: false } }), 403, 'FORBIDDEN');
    await expectError(await w.deleteTransfer(view.id, itemId), 403, 'FORBIDDEN');

    const [row] = await w.transferRows(view.id);
    expect(row!.linkage).toMatchObject({ adjustSalary: true });
  });

  it('合同变更：没有合同“变更”按钮 → 403；员工在任职对象范围外 → 404，均不留明细', async () => {
    const { w, mover, view } = await setup('oa32-contract');
    const contractId = await w.contractOf(mover);
    const linkage = { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } };
    w.access.deniedButtons.add('change');

    // 按钮是功能权：缺“变更”按钮一律 403 FORBIDDEN（范围外才是 404），不接受二选一
    await expectError(
      await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage })),
      403,
      'FORBIDDEN',
    );
    expect(await w.transferRows(view.id)).toEqual([]);
    w.access.deniedButtons.clear();
    w.access.employment = only(w.b); // 员工在 A 下 → 范围外
    await expectError(
      await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage })),
      404,
      'NOT_FOUND',
    );

    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('提交时按当前权限复核已存明细：权限在保存后被撤 → 提交被拒，单据仍为草稿', async () => {
    const { w, mover, view } = await setup('oa32-submit');
    await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage: { adjustSalary: true } }));
    w.access.deniedFields.add('adjustSalary');

    const res = await w.submit(view.id);

    expect(res.status, await res.clone().text()).toBe(403);
    expect((await w.headRow(view.id)).approval_status).toBe(0);
  });
});

describe('AC-OA-09 变更合同', () => {
  it('调动到另一法人公司并勾选变更合同：执行成功，新合同版本落到新法人公司 + 一条合同变更记录', async () => {
    const { w, mover, view } = await setup('oa09');
    const contractId = await w.contractOf(mover);
    const otherCompany = await w.otherLegalCompany(); // 目标部门所属的另一法人公司（DEC-029 跨法人调动）
    const linkage = { contract: { targetId: contractId, fields: { endDate: '2029-10-09', companyId: otherCompany } } };
    await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage }));
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.acted(view.id, w.head, 'approve');

    await w.run();

    const [row] = await w.transferRows(view.id);
    expect(row, JSON.stringify(row)).toMatchObject({ exec_phase: 2, execution_result: 1 });
    // 生效日在未来：任职与联动由任职定时任务在生效日落地（审批通过 ≠ 生效，DEC-052 / DEC-056）
    expect(await w.contractChanges(mover), '生效日之前不得改合同').toEqual([]);
    const activated = await runEmploymentActivations(
      testDb().db,
      cmd(),
      { tenantId: w.tenant.id },
      { clock: () => new Date('2026-11-01T12:00:00Z') },
    );
    expect(activated.runs).toHaveLength(1);
    const changes = await w.contractChanges(mover);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.before).toBe(contractId);
    expect(changes[0]!.after).not.toBe(contractId);
    // 新合同版本值：终止日与法人公司改为联动值、版本号 + 1、指向原合同；类型沿用原合同；原合同行保持原值
    const versions = await w.inTenant(async (tx) =>
      resultRows<Record<string, unknown>>(
        await tx.execute(sql`SELECT id, version_no, previous_contract_id, root_contract_id, end_date::text AS end_date,
          type_id, company_id FROM contract_records WHERE employee_id = ${mover} AND NOT deleted ORDER BY version_no`),
      ),
    );
    expect(versions).toHaveLength(2);
    const [origin, next] = versions;
    expect(origin).toMatchObject({ id: contractId, version_no: 1, end_date: '2028-08-31' });
    expect(origin!.company_id, '跨法人：原合同行保持原法人公司').not.toBe(otherCompany);
    expect(next).toMatchObject({
      id: changes[0]!.after,
      version_no: 2,
      previous_contract_id: contractId,
      root_contract_id: origin!.root_contract_id,
      end_date: '2029-10-09',
      type_id: origin!.type_id, // 类型沿用原合同
      company_id: otherCompany, // 法人公司随联动改到另一法人
    });
  });
});

describe('AC-OA-27 合同变更披露（逐行编码）', () => {
  it('合同字段编码带明细身份；一个字段不可见只隐去该字段，其余照常', async () => {
    const { w, mover, view } = await setup('oa27');
    const contractId = await w.contractOf(mover);
    const fields = { endDate: '2029-10-09', signingDate: '2026-10-02' };
    const added = await w.transfer(
      view.id,
      w.transferBody(mover, { orgId: w.b }, { linkage: { contract: { targetId: contractId, fields } } }),
    );
    const read = async () =>
      bodyOf(await w.call('GET', `/api/tenant/org-adjustment/adjustments/${view.id}/items/transfer`)) as Promise<{
        items: { id: string; contractChange: Record<string, unknown> | null }[];
      }>;

    expect((await read()).items[0]).toMatchObject({
      id: added.items[0]!.id,
      contractChange: { endDate: '2029-10-09', signingDate: '2026-10-02' },
    });
    w.access.hiddenFields.add('endDate'); // 合同对象的字段查看权（§4.5：按合同对象判，不按调整单对象）
    const hidden = (await read()).items[0]!.contractChange;
    expect(hidden).toMatchObject({ signingDate: '2026-10-02' });
    expect(hidden).not.toHaveProperty('endDate');
    w.access.contract = only(w.b); // 目标合同所属员工在 A 下 → 合同整体不可见，也不暴露“是否变更合同”
    expect((await read()).items[0]!.contractChange).toBeNull();
  });
});

describe('AC-OA-27 盲审：两份合同只有一份在审批人范围内', () => {
  async function twoContracts(label: string, swap: boolean, recheck = false) {
    const recheckNode = { ...oaNodes()[0]!, key: 'n3', name: 'HRBP复核', historySameAssigneeSkip: true };
    const w = await transferWorld(testDb().db, label, recheck ? { nodes: [...oaNodes(), recheckNode] } : {});
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const movers = [await w.staff(w.a), await w.staff(w.b)];
    for (const mover of swap ? [...movers].reverse() : movers) {
      const contractId = await w.contractOf(mover);
      const linkage = { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } };
      await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage }));
    }
    await w.submitted(view.id);
    w.access.contract = only(w.a); // 提交后审批人的合同范围收窄：B 下员工的合同不再可见
    return { w, view };
  }

  it.each([false, true])('手动同意被拦（行序对调=%s），待办转异常管理员，单据仍审批中', async (swap) => {
    const { w, view } = await twoContracts(`oa27-blind-${swap}`, swap);

    await expectError(await w.act(view.id, w.hrbp, 'approve'), 403, 'FORBIDDEN', 'APPROVAL_BLIND_REVIEW');

    expect(await w.state(view.id)).toMatchObject({ approval: 1 });
  });

  it.each([false, true])('历史同人自动跳过也被拦（行序对调=%s）：转异常管理员，不自动同意', async (swap) => {
    const { w, view } = await twoContracts(`oa27-skip-${swap}`, swap, true);
    w.access.contract = undefined;
    await w.acted(view.id, w.hrbp, 'approve');
    w.access.contractByUser = new Map([[w.hrbp.userId, only(w.a)]]); // 只有复核人（HRBP）的合同范围收窄
    await w.acted(view.id, w.head, 'approve');

    const pending = (await w.instance(view.id)).tasks.filter((task) => task.status === 'pending');
    expect(pending).toEqual([
      expect.objectContaining({ nodeKey: 'n3', assigneeUserId: w.exceptionAdmin, origin: 'blind_review' }),
    ]);
    expect(await w.state(view.id)).toMatchObject({ approval: 1, queued: 0 });
  });
});
