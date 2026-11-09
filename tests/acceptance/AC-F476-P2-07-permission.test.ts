/**
 * AC-F476-07（P2 组织调整部分）：冻结之后撤销字段 / 引用权限，预览与导出里的名称、负责人、原值同时消失；
 * 之后新授予的权限不超过办理时的披露上限（三者交集：办理时上限 ∩ 节点表单 ∩ 当前权限）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { reader } from './AC-OA-read-support.js';
import { NAME_A, NAME_B } from './AC-F476-support.js';
import { CHILD_NAME, everything, handledScene, nodeOf, OLD_HEAD } from './AC-F476-P2-support.js';

const testDb = useTestDb();
const hide = (w: Awaited<ReturnType<typeof flowWorld>>, user: string, ...fields: string[]) =>
  w.access.hiddenByUser.set(user, new Set(fields));

describe('AC-F476-07 冻结后撤权（预览 / 导出）', () => {
  it('撤销 adjustmentRange：未变更下级名称为 null 并记 masked，名称不在预览 / 导出任何文本里；被明细指向的节点仍可见', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-07-range');
    const s = await handledScene(w);
    const before = await everything(w, s.id, w.hrbp.userId);
    expect(nodeOf(before.preview, s.child).name).toBe(CHILD_NAME);

    hide(w, w.hrbp.userId, 'adjustmentRange');
    const after = await everything(w, s.id, w.hrbp.userId);
    expect(nodeOf(after.preview, s.child)).toMatchObject({ name: null });
    expect(nodeOf(after.preview, s.child).masked).toContain('name');
    expect(after.text).not.toContain(CHILD_NAME);
    expect(nodeOf(after.preview, w.a).name).toBe(NAME_A);
  });

  it('撤销 orgItems.name：办理时名称 A 与事后名称 B 都不出现，节点记 newName；导出同', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-07-name');
    const s = await handledScene(w);
    hide(w, w.hrbp.userId, 'orgItems.name');
    const mine = await everything(w, s.id, w.hrbp.userId);
    expect(mine.text).not.toContain(NAME_A);
    expect(mine.text).not.toContain(NAME_B);
    expect(nodeOf(mine.preview, w.a).masked).toContain('newName');
    const items = await reader(w).items(s.id, w.hrbp.userId);
    expect(JSON.stringify(items)).not.toContain(NAME_A);
  });

  it('撤销 orgItems.targetOrgId（引用权限）：明细不再指向目标，节点不带标记、不露出办理时名称；与没有这条明细的树同形', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-07-target');
    const s = await handledScene(w);
    hide(w, w.hrbp.userId, 'orgItems.targetOrgId');
    const mine = await everything(w, s.id, w.hrbp.userId);
    expect(mine.text).not.toContain(NAME_A);
    expect(nodeOf(mine.preview, w.a)).toMatchObject({ mark: null, itemId: null });
  });
});

describe('AC-F476-07 披露上限：事后新授予的权限不超过办理时', () => {
  it('办理时看不到上级字段：之后授予 orgItems.parentOrgId，冻结读仍记 masked；从未被限制的发起人不受影响', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-07-ceiling');
    hide(w, w.hrbp.userId, 'orgItems.parentOrgId'); // 办理时：HRBP 看不到明细的新上级
    const s = await handledScene(w);
    w.access.hiddenByUser.clear(); // 办理后：授予（恢复）该字段查看权

    const mine = await everything(w, s.id, w.hrbp.userId);
    expect(nodeOf(mine.preview, w.a).masked).toContain('parentOrgId');
    // 其余办理时可见的值照常（三者交集只收窄，不改写）
    expect(nodeOf(mine.preview, w.a)).toMatchObject({ name: NAME_A, personInChargeName: OLD_HEAD });

    const initiator = await everything(w, s.id, w.hr.id);
    expect(nodeOf(initiator.preview, w.a).masked).not.toContain('parentOrgId');
  });
});
