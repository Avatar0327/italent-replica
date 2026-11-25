/**
 * BE-11c-b 第 5 轮 P2-1 / P2-2（R2-T08 §6.3 / §8.3）：审批人编辑的错误信封与读取接口用同一份节点披露，
 * 公开 HTTP 回归，断言的都是业务结果（状态码、业务码、行 ID、响应文本）：
 *  - P2-1 节点开放组织明细分区但隐藏 `orgItems.targetOrgId`：读组织分区看不到目标部门 ID，缩小范围的 400
 *    `ORG_ADJUSTMENT_OUT_OF_RANGE` 的 `details.items[].orgId` 同样不得带出；可见行 ID 与业务错误码保留；
 *  - P2-2 有申请单查看权的当前审批人，字段权限遮蔽全部 orgItems.*：组织分区读 404、调动分区读 200，能看到引用本单
 *    新增组织的调动行；
 *    缩小范围的 400 信封里这条可读调动行不得被折叠（行引用可见性按读接口口径算，不随组织分区是否披露变）。
 */
import { useTestDb } from '@italent/testkit';
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld, type TransferWorld } from './AC-OA-11cb-support.js';
import { bodyOf, expectError } from './AC-OA-head-support.js';
import { newOrg, rename } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

/** 审批人只能走审批路径读（没有申请单对象查看权）；节点表单按前缀丢字段。 */
async function blindWorld(label: string, keep: (code: string) => boolean) {
  const formFields = ORG_ADJUSTMENT_FORM_FIELDS.filter(keep);
  const w = await transferWorld(testDb().db, label, {
    nodes: oaNodes([{ formFields, editableFields: ['adjustmentRange'] }]),
  });
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  return { w, view };
}
const section = (w: TransferWorld, id: string, name: 'org' | 'transfer') =>
  w.call('GET', `/api/tenant/org-adjustment/adjustments/${id}/items/${name}`, {}, w.hrbp.userId);
const narrow = (w: TransferWorld, id: string) => w.act(id, w.hrbp, 'edit', { fields: { adjustmentRange: [w.a] } });

describe('P2-1 错误信封字段裁剪与读取接口同一份节点披露', () => {
  it('节点隐藏 orgItems.targetOrgId：读组织分区无目标部门 ID；缩小范围的 400 同样不带，行 ID 与业务码保留', async () => {
    const { w, view } = await blindWorld('r5-envelope-target-org', (code) => code !== 'orgItems.targetOrgId');
    const rowId = (await w.item(view.id, rename(w.b, { name: `ZZ_改名${uniqueSuffix()}` }))).items[0]!.id;
    await w.submitted(view.id);
    w.access.viewDenied = true;
    const read = await section(w, view.id, 'org');
    expect(read.status, await read.clone().text()).toBe(200);
    expect(await read.clone().text(), '读接口不带目标部门 ID').not.toContain(w.b);

    const res = await narrow(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    const text = await res.clone().text();
    expect(text, '可见行 ID 保留').toContain(rowId);
    expect(text, '信封不得带出节点隐藏的目标部门 ID').not.toContain(w.b);
  });

  it('节点开放 orgItems.targetOrgId 时信封照常带目标部门 ID（不过度裁剪）', async () => {
    const { w, view } = await blindWorld('r5-envelope-target-org-open', () => true);
    await w.item(view.id, rename(w.b, { name: `ZZ_改名${uniqueSuffix()}` }));
    await w.submitted(view.id);
    w.access.viewDenied = true;

    const res = await narrow(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    expect(await res.clone().text()).toContain(w.b);
  });
});

describe('P2-2 行引用可见性不随组织分区是否披露变化', () => {
  /** HR 路径（有申请单对象查看权）：字段权限遮蔽全部 orgItems.*，组织分区不披露；调动分区照常。 */
  it('组织分区 404、调动分区 200：缩小范围的 400 仍带可读的调动行 ID，不带组织行 ID', async () => {
    const { w, view } = await blindWorld('r5-envelope-transfer-only', () => true);
    const orgRow = (await w.item(view.id, newOrg(w.b, { name: `ZZ_新增组织${uniqueSuffix()}` }))).items[0]!.id;
    const transferRow = await w.seed(view.id, await w.staff(w.a), { departmentId: null, departmentItemId: orgRow });
    await w.submitted(view.id);
    for (const code of ORG_ADJUSTMENT_FORM_FIELDS.filter((c) => c.startsWith('orgItems.')))
      w.access.hiddenFields.add(code);
    await expectError(await section(w, view.id, 'org'), 404, 'NOT_FOUND');
    const read = await section(w, view.id, 'transfer');
    expect(read.status, await read.clone().text()).toBe(200);
    expect(await read.clone().text(), '读接口能看到该调动行').toContain(transferRow);

    const res = await narrow(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED');
    const text = await res.clone().text();
    expect(text, '可读调动行不得被折叠').toContain(transferRow);
    expect(text, '组织分区不披露：组织行 ID 折叠').not.toContain(orgRow);
    expect((await bodyOf(res)).error?.details?.reason).toBeTruthy();
  });

  it('同根因：HR 写路径（头 PATCH 缩小范围）的 400 同口径——组织分区遮蔽则折叠组织行，可读调动行保留', async () => {
    const { w, view } = await blindWorld('r5-envelope-hr-head', () => true);
    const orgRow = (await w.item(view.id, newOrg(w.b, { name: `ZZ_新增组织${uniqueSuffix()}` }))).items[0]!.id;
    const transferRow = await w.seed(view.id, await w.staff(w.a), { departmentId: null, departmentItemId: orgRow });
    for (const code of ORG_ADJUSTMENT_FORM_FIELDS.filter((c) => c.startsWith('orgItems.')))
      w.access.hiddenFields.add(code);

    const res = await w.patch(view.id, { adjustmentRange: [w.a] }, (await w.stored(view.id))!.revision);

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    const text = await res.clone().text();
    expect(text, '可读调动行保留').toContain(transferRow);
    expect(text, '组织分区不披露：组织行 ID 折叠').not.toContain(orgRow);
  });
});
