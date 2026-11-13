/**
 * AC-F476-01（P2 部分）：组织调整预览 / 架构图导出两个入口，已办按办理时的值（A）读，按节点字段裁剪；
 * 在办 / 发起人读现值（B）；冻结份缺预览输入（P1 形状）时 503，不退回现值（DEC-807）。
 * 审批中心详情与组织调整详情 / 明细两个入口由 P1 覆盖，本文件不重复。
 */
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { expectError } from './AC-OA-head-support.js';
import { reader } from './AC-OA-read-support.js';
import { NAME_A, NAME_B } from './AC-F476-support.js';
import { everything, exportRes, handledScene, nodeOf, OLD_HEAD, withoutPreviewInput } from './AC-F476-P2-support.js';

const testDb = useTestDb();

describe('AC-F476-01 预览 / 导出读办理时的值', () => {
  it('已办 HRBP：预览节点与导出（调整前 / 后）都是办理时名称 A 和办理时负责人；发起人读现值 B', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-01-handled');
    const s = await handledScene(w);
    const mine = await everything(w, s.id, w.hrbp.userId);
    expect(nodeOf(mine.preview, w.a)).toMatchObject({ name: NAME_A, mark: 'changed', personInChargeName: OLD_HEAD });
    expect(mine.before.svg).toContain(NAME_A);
    expect(mine.after.svg).toContain(NAME_A);
    expect(mine.text).not.toContain(NAME_B);

    const initiator = await everything(w, s.id, w.hr.id);
    expect(nodeOf(initiator.preview, w.a).name).toBe(NAME_B);
    expect(initiator.after.svg).toContain(NAME_B);
    expect(initiator.text).not.toContain(NAME_A);
  });

  it('已办负责人（驳回人）同样读自己办理时的值 A；重提后在办的 HRBP 读现值 B', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-01-pending');
    const s = await handledScene(w);
    expect(nodeOf(await reader(w).preview(s.id, w.head.userId), w.a).name).toBe(NAME_A);
    const resubmit = await w.instanceAction(s.id, 'resubmit'); // 驳回后重提：HRBP 重新有待办
    expect(resubmit.status, await resubmit.clone().text()).toBe(200);
    const pending = await everything(w, s.id, w.hrbp.userId);
    expect(nodeOf(pending.preview, w.a).name).toBe(NAME_B);
    expect(pending.text).not.toContain(NAME_A);
    // 负责人本轮还没轮到，没有待办：读自己上一轮办理时的份
    expect(nodeOf(await reader(w).preview(s.id, w.head.userId), w.a).name).toBe(NAME_A);
  });

  it('节点表单不含名称：已办预览与导出都不含名称（办理时的 A 和现值 B 都不出现），按节点字段裁剪', async () => {
    const formFields = ORG_ADJUSTMENT_FORM_FIELDS.filter((field) => field !== 'orgItems.name');
    const nodes = oaNodes([{ formFields, editableFields: ['subject', 'content'] }]);
    const w = await flowWorld(testDb().db, 'f476p2-01-node-fields', { nodes });
    const s = await handledScene(w);
    const mine = await everything(w, s.id, w.hrbp.userId);
    expect(mine.text).not.toContain(NAME_A);
    expect(mine.text).not.toContain(NAME_B);
    expect(nodeOf(mine.preview, w.a).masked).toContain('newName');
  });

  it('冻结份缺预览输入：预览与导出 503，不退回现值；详情仍读冻结份', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-01-missing');
    const s = await handledScene(w);
    await withoutPreviewInput(w, w.hrbp.userId);
    const preview = await reader(w).previewRes(s.id, w.hrbp.userId);
    await expectError(preview, 503, 'SERVICE_UNAVAILABLE');
    expect(await preview.clone().text()).not.toContain(NAME_B);
    await expectError(await exportRes(w, s.id, w.hrbp.userId), 503, 'SERVICE_UNAVAILABLE');
    expect((await reader(w).detail(s.id, w.hrbp.userId)).approvalInstanceId).toBe(s.instanceId);
    // 发起人读现值，不受影响
    expect(nodeOf(await reader(w).preview(s.id, w.hr.id), w.a).name).toBe(NAME_B);
  });
});
