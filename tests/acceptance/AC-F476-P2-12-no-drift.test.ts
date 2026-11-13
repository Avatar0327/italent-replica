/**
 * AC-F476-12（P2 组织调整部分）：冻结之后增删明细、改被引用组织的名称、改预览树（改上级 / 换负责人），
 * 已办读到的预览与导出（树形、名称、负责人、文件名里的范围组织名）逐字不变；现值读者（发起人）照常漂移。
 * 看不到的引用与不存在的引用在响应里同形。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { reader } from './AC-OA-read-support.js';
import { NAME_A } from './AC-F476-support.js';
import {
  appendOrgVersion,
  CHILD_NAME,
  CHILD_RENAMED,
  everything,
  handledScene,
  NEW_HEAD,
  orgNameOf,
  nodeOf,
  OLD_HEAD,
  RANGE_RENAMED,
} from './AC-F476-P2-support.js';
import { flatten } from './AC-OA-read-support.js';

const testDb = useTestDb();
const ADDED = 'ZZ_事后新增组织';

describe('AC-F476-12 冻结后不漂移', () => {
  it('删明细 / 新增明细 / 下级改名 / 范围组织改名 / 下级改上级 / 换负责人：已办预览与导出逐字不变，发起人读到现值', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-12-drift');
    const s = await handledScene(w);
    const rangeName = await orgNameOf(w, w.a);
    const frozen = await everything(w, s.id, w.hrbp.userId);
    expect(frozen.text).toContain(NAME_A);
    expect(frozen.text).toContain(CHILD_NAME);
    expect(frozen.text).toContain(OLD_HEAD);
    expect(frozen.before.fileName).toContain(rangeName);

    // 申请人事后改单：删掉改名行、新增一条新建组织行
    const removed = await w.deleteItem(s.id, s.itemId);
    expect(removed.status, await removed.clone().text()).toBe(200);
    const added = await w.addItem(s.id, newOrg(w.a, { name: ADDED }));
    expect(added.status, await added.clone().text()).toBe(201);
    // 外部改组织：下级改名、范围组织改名、下级换上级、范围组织换负责人
    await appendOrgVersion(w, s.child, { name: CHILD_RENAMED });
    await appendOrgVersion(w, w.a, { name: RANGE_RENAMED });
    await appendOrgVersion(w, s.child, { parentOrgId: w.b });
    const newHead = await w.person(NEW_HEAD, w.a);
    await w.setOrgRoles(w.a, { head: newHead.employeeId });

    const again = await everything(w, s.id, w.hrbp.userId);
    expect(again.preview).toEqual(frozen.preview);
    expect(again.before).toEqual(frozen.before);
    expect(again.after).toEqual(frozen.after);
    for (const drifted of [ADDED, CHILD_RENAMED, RANGE_RENAMED, NEW_HEAD]) expect(again.text).not.toContain(drifted);

    const live = await everything(w, s.id, w.hr.id);
    expect(live.text).toContain(ADDED);
    expect(live.text).not.toContain(NAME_A);
  });

  it('详情的调整范围名称与明细行同样不随事后改名漂移（P1 回归）', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-12-detail');
    const s = await handledScene(w);
    const r = reader(w);
    const before = JSON.stringify([await r.detail(s.id, w.hrbp.userId), await r.items(s.id, w.hrbp.userId)]);
    await appendOrgVersion(w, w.a, { name: RANGE_RENAMED });
    const after = JSON.stringify([await r.detail(s.id, w.hrbp.userId), await r.items(s.id, w.hrbp.userId)]);
    expect(after).toBe(before);
    expect(after).not.toContain(RANGE_RENAMED);
  });

  it('没有查看权的引用与不存在的引用同形：看不到 targetOrgId 时树里没有任何标记、明细引用，文本里没有被引用方的名称', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-12-hidden-ref');
    const s = await handledScene(w);
    w.access.hiddenByUser.set(w.hrbp.userId, new Set(['orgItems.targetOrgId', 'adjustmentRange']));
    const mine = await everything(w, s.id, w.hrbp.userId);
    expect(flatten(mine.preview.roots).every((n) => n.mark === null && n.itemId === null)).toBe(true);
    expect(mine.text).not.toContain(NAME_A);
    expect(mine.text).not.toContain(CHILD_NAME);
    expect(nodeOf(mine.preview, w.a).name).toBeNull();
  });
});
