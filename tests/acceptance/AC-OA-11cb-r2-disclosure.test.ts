/**
 * BE-11c-b 第 2 轮 P1-5 / P2-1（R2-T08 §4.5）：调动分区的统一披露。
 *  - P1-5 审批人办理后（转交）份被冻结；之后即使被授予合同查看权，合同变更逐行编码也只给办理时看得见的那几行：
 *    逐行编码 ∩ 办理份披露上限 ∩ 节点表单 ∩ 当前权限；审批中心详情与调动明细读接口同一结果；
 *  - P2-1 删除组织行被调动行引用的 409 只给本人可见的调动行 ID。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld } from './AC-OA-11cb-support.js';
import { bodyOf, only } from './AC-OA-head-support.js';

const testDb = useTestDb();

interface ItemsBody {
  items: { id: string; employeeId?: string; contractChange: Record<string, unknown> | null }[];
}

describe('P1-5 办理后授予合同查看权不得重新展开已排除的合同', () => {
  async function transferred(label: string) {
    const w = await transferWorld(testDb().db, label, {
      nodes: oaNodes([{ actions: { transfer: true } }]),
    });
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const movers = [await w.staff(w.a), await w.staff(w.b)];
    const itemIds: string[] = [];
    for (const mover of movers) {
      const contractId = await w.contractOf(mover);
      itemIds.push(
        await w.seed(view.id, mover, {
          linkageInput: { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } },
        }),
      );
    }
    await w.submitted(view.id);
    // 提交后审批人的合同范围收窄：B 下员工的合同不可见 → 盲审，只能转交
    // 合同范围只含 A 下那名员工（按人，org 维度单靠部门 ID 不会命中在职员工）
    const scopeA = {
      ...only(w.a),
      terms: [{ dimension: 'management' as const, orgIds: [w.a], personIds: [movers[0]!] }],
    };
    w.access.contractByUser = new Map([[w.hrbp.userId, scopeA]]);
    const target = await w.member('转交目标');
    const task = (await w.instance(view.id)).tasks.find((t) => t.status === 'pending')!;
    const moved = await w.call(
      'POST',
      `/api/tenant/approval/tasks/${task.id}/transfer`,
      { ifMatch: (await w.instance(view.id)).revision, body: { toUserId: target, comment: '转交' } },
      w.hrbp.userId,
    );
    expect(moved.status, await moved.clone().text()).toBe(200);
    return { w, view, itemIds };
  }

  const itemsOf = async (w: Awaited<ReturnType<typeof transferWorld>>, id: string) =>
    (await bodyOf(
      await w.call('GET', `/api/tenant/org-adjustment/adjustments/${id}/items/transfer`, {}, w.hrbp.userId),
    )) as unknown as ItemsBody;

  it('转交后授予合同全部范围：明细读接口仍只给办理时可见的那份合同，被排除的一份不重新出现', async () => {
    const { w, view, itemIds } = await transferred('r2-grant-items');
    const before = await itemsOf(w, view.id);
    expect(before.items.find((item) => item.id === itemIds[0])!.contractChange).toMatchObject({
      endDate: '2029-10-09',
    });
    expect(before.items.find((item) => item.id === itemIds[1])!.contractChange).toBeNull();

    w.access.contractByUser = undefined; // 授予合同对象全部范围
    const after = await itemsOf(w, view.id);

    expect(after.items.find((item) => item.id === itemIds[0])!.contractChange).toMatchObject({ endDate: '2029-10-09' });
    expect(after.items.find((item) => item.id === itemIds[1])!.contractChange).toBeNull();
  });

  it('审批中心详情与调动明细读接口给出同一份合同变更字段集', async () => {
    const { w, view, itemIds } = await transferred('r2-grant-center');
    w.access.contractByUser = undefined;

    const detail = await w.detail((await w.instance(view.id)).id, w.hrbp.userId);
    const centerCodes = Object.keys(detail.form.values).filter((code) => code.includes('.contractChange.'));
    const items = await itemsOf(w, view.id);

    expect(centerCodes.every((code) => code.startsWith(`transferItems.${itemIds[0]}.`))).toBe(true);
    expect(centerCodes.length).toBeGreaterThan(0);
    expect(items.items.find((item) => item.id === itemIds[1])!.contractChange).toBeNull();
  });
});
