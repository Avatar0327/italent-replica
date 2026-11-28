/**
 * BE-11c-b 第 4 轮 P2-1 ～ P2-3（R2-T08 §6.3 / §8.3）：三处公开 HTTP 回归，断言的都是业务结果（状态码、业务码、行内容、
 * 响应文本），夹具走公开写入口或可信夹具：
 *  - P2-1 职责转交下属没有现行任职：新增 / 改行 / 提交都要拒绝，与直接调动（transfer/linkage/validation）同口径，
 *    不能因为“查不到任职”就跳过范围复核；
 *  - P2-2 审批人编辑同键重放：按首次编辑时的新旧两侧、用当前权限重判；首次取消带编后只撤编制字段写权，
 *    原键重放 `/edit` 与 `/approve`（编辑并同意）都要 403，不能拿“当前行”当新旧两侧；
 *  - P2-3 审批人编辑的错误信封按审批节点字段投影折叠：节点表单不含调动分区时，调动分区读 404，
 *    信封里也不能带调动行 ID（同理组织明细分区）。
 */
import { useTestDb } from '@italent/testkit';
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld, type TransferWorld } from './AC-OA-11cb-support.js';
import { bodyOf, expectError } from './AC-OA-head-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const APPROVAL = '/api/tenant/approval';

/** 编制方案 + 两个部门的编制容量：带编的行才有可写的编制（localCapacity）。 */
async function seedEstablishment(w: TransferWorld) {
  const post = async (path: string, body: object) => {
    const res = await w.call('POST', `/api/tenant/${path}`, { ifMatch: 0, body });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const scheme = await post('establishment/schemes', {
    name: `ZZ_编制方案${uniqueSuffix()}`,
    periodType: 'annual',
    maintenanceMode: 'both',
    startDate: '2026-01-01',
  });
  for (const orgId of [w.a, w.b])
    await post('establishment/capacities', {
      orgId,
      schemeId: scheme.id,
      periodStart: '2026-01-01',
      effectiveDate: '2026-01-01',
      localCapacity: 5,
      inclusiveCapacity: 10,
      strictControl: false,
    });
}

describe('P2-1 职责转交下属没有现行任职：与直接调动同口径拒绝', () => {
  async function dutyWorld(label: string) {
    const w = await transferWorld(testDb().db, label);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const mover = await w.staff(w.a);
    // 同租户的员工，但从未入职：没有任何现行任职记录
    const subordinate = await w.employee(`ZZ_无任职下属${uniqueSuffix()}`);
    const receiver = await w.staff(w.b);
    const linkage = {
      dutyTransfer: {
        subordinates: [{ employeeId: subordinate.id, receiverId: receiver, relation: 'direct' }],
        orgRoles: [],
      },
    };
    return { w, view, mover, linkage };
  }

  it('新增：下属没有现行任职 → 400 TRANSFER_PERSON_NOT_ELIGIBLE，不留明细', async () => {
    const { w, view, mover, linkage } = await dutyWorld('r4-duty-add');

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage }));

    await expectError(res, 400, 'VALIDATION_FAILED', 'TRANSFER_PERSON_NOT_ELIGIBLE');
    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('改行补上无任职下属 → 400，行原样', async () => {
    const { w, view, mover, linkage } = await dutyWorld('r4-duty-patch');
    const itemId = await w.seed(view.id, mover);
    const before = await w.transferRows(view.id);

    const res = await w.patchTransfer(view.id, itemId, { linkage });

    await expectError(res, 400, 'VALIDATION_FAILED', 'TRANSFER_PERSON_NOT_ELIGIBLE');
    expect(await w.transferRows(view.id)).toEqual(before);
  });

  it('提交：已存的行里下属没有现行任职 → 400，单据仍为草稿', async () => {
    const { w, view, mover, linkage } = await dutyWorld('r4-duty-submit');
    await w.seed(view.id, mover, { linkageInput: linkage }); // 可信夹具：绕过写入口造出该状态
    const before = await w.state(view.id);

    const res = await w.submit(view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', 'TRANSFER_PERSON_NOT_ELIGIBLE');
    expect(await w.state(view.id)).toEqual(before);
  });
});

describe('P2-2 审批人编辑同键重放按首次的新旧两侧重判', () => {
  async function approvalWorld(label: string, editMode: 'separate' | 'with_approve') {
    const w = await transferWorld(testDb().db, label, {
      nodes: oaNodes([{ editMode, editableFields: ['transferItems.withEstablishment'] }]),
    });
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    await seedEstablishment(w);
    const itemId = await w.seed(view.id, await w.staff(w.a), { withEstablishment: true });
    await w.submitted(view.id);
    const instance = await w.instance(view.id);
    const task = instance.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === w.hrbp.userId)!;
    const fields = { 'transferItems.withEstablishment': [{ itemId, value: false }] };
    return { w, view, itemId, instance, task, fields };
  }

  it('/edit：先取消带编，再只撤编制 localCapacity 写权（保留编制范围）→ 原键重放 403', async () => {
    const { w, instance, task, fields } = await approvalWorld('r4-replay-edit', 'separate');
    const request = { ifMatch: instance.revision, body: { fields }, idempotencyKey: randomUUID() };
    const path = `${APPROVAL}/tasks/${task.id}/edit`;
    const first = await w.call('POST', path, request, w.hrbp.userId);
    expect(first.status, await first.clone().text()).toBe(200);

    w.access.deniedFields.add('localCapacity');
    const replay = await w.call('POST', path, request, w.hrbp.userId);

    await expectError(replay, 403, 'FORBIDDEN');
  });

  it('/approve（编辑并同意）：同样的撤权后原键重放 403', async () => {
    const { w, instance, task, fields } = await approvalWorld('r4-replay-approve', 'with_approve');
    const request = {
      ifMatch: instance.revision,
      body: { comment: '合成意见', fields },
      idempotencyKey: randomUUID(),
    };
    const path = `${APPROVAL}/tasks/${task.id}/approve`;
    const first = await w.call('POST', path, request, w.hrbp.userId);
    expect(first.status, await first.clone().text()).toBe(200);

    w.access.deniedFields.add('localCapacity');
    const replay = await w.call('POST', path, request, w.hrbp.userId);

    await expectError(replay, 403, 'FORBIDDEN');
  });

  it('权限未变时同键重放仍返回首次结果（不误拒）', async () => {
    const { w, instance, task, fields } = await approvalWorld('r4-replay-same', 'separate');
    const request = { ifMatch: instance.revision, body: { fields }, idempotencyKey: randomUUID() };
    const path = `${APPROVAL}/tasks/${task.id}/edit`;
    const first = await w.call('POST', path, request, w.hrbp.userId);
    expect(first.status, await first.clone().text()).toBe(200);

    const replay = await w.call('POST', path, request, w.hrbp.userId);

    expect(replay.status, await replay.clone().text()).toBe(200);
  });
});

describe('P2-3 审批人编辑错误信封按审批节点字段投影折叠', () => {
  /** 节点表单不含调动分区 / 组织明细分区字段；审批人只能走审批路径读（没有申请单对象查看权）。 */
  async function blindWorld(label: string, drop: string) {
    const formFields = ORG_ADJUSTMENT_FORM_FIELDS.filter((code) => !code.startsWith(drop));
    const w = await transferWorld(testDb().db, label, {
      nodes: oaNodes([{ formFields, editableFields: ['adjustmentRange'] }]),
    });
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const rowId = await w.seed(view.id, await w.staff(w.a));
    // 组织行挂在将被缩出范围的部门 B 下：缩小范围后它出现在 400 的 items 里
    const orgRow = (await w.item(view.id, newOrg(w.b, { name: `ZZ_组织行${uniqueSuffix()}` }))).items[0]!.id;
    await w.submitted(view.id);
    w.access.viewDenied = true;
    return { w, view, rowId, orgRow };
  }
  const section = (w: TransferWorld, id: string, name: 'org' | 'transfer') =>
    w.call('GET', `/api/tenant/org-adjustment/adjustments/${id}/items/${name}`, {}, w.hrbp.userId);

  it('节点表单不含调动分区：读调动分区 404；缩小范围的 400 保留错误码，details 不带调动行 ID', async () => {
    const { w, view, rowId } = await blindWorld('r4-envelope-transfer', 'transferItems.');
    await expectError(await section(w, view.id, 'transfer'), 404, 'NOT_FOUND');

    const res = await w.act(view.id, w.hrbp, 'edit', { fields: { adjustmentRange: [w.a] } });

    await expectError(res, 400, 'VALIDATION_FAILED');
    const text = await res.clone().text();
    expect(text, '调动行 ID 不能出现在信封里').not.toContain(rowId);
    expect((await bodyOf(res)).error?.details?.reason).toBeTruthy();
  });

  it('节点表单不含组织明细分区：读组织分区 404；缩小范围的 400 同样不带组织行 ID', async () => {
    const { w, view, orgRow } = await blindWorld('r4-envelope-org', 'orgItems.');
    await expectError(await section(w, view.id, 'org'), 404, 'NOT_FOUND');

    const res = await w.act(view.id, w.hrbp, 'edit', { fields: { adjustmentRange: [w.a] } });

    await expectError(res, 400, 'VALIDATION_FAILED');
    expect(await res.clone().text(), '组织行 ID 不能出现在信封里').not.toContain(orgRow);
  });
});
