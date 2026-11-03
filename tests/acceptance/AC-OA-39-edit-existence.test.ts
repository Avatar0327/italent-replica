/**
 * R2-T08 F-443：审批中编辑，同单内目标组织已出审批人组织范围的明细行，与不存在的明细行同码、同文案、同 HTTP 状态
 * （F-339 ③ 存在性侧信道：审批人不得靠错误差异探测范围外的行是否存在）。原先越界行是 404 NOT_FOUND“组织不存在”，
 * 不存在的行是 400 VALIDATION_FAILED，两者可区分。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { only } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

describe('AC-OA-39 F-443 审批中编辑：越界行与不存在行不可区分', () => {
  it('同单内目标组织出范围的行 = 不存在的行：状态、错误码、文案、详情完全一致，单据不变', async () => {
    const w = await flowWorld(testDb().db, 'oa39-exist');
    // 调整范围（w.a）在审批人组织范围内，行的目标是范围内的下级组织 c、c 出了审批人范围：越界发生在行上，不在头上
    const c = await w.org(`丙${uniqueSuffix()}`, w.a);
    const { id, itemId } = await w.draft(rename(c));
    await w.submitted(id);
    w.access.org = only(w.a);
    const edit = (target: string) =>
      w.act(id, w.hrbp, 'edit', { fields: { 'orgItems.name': [{ itemId: target, value: '探测改名' }] } });
    const missing = await edit(randomUUID());
    expect(missing.status, await missing.clone().text()).toBe(400);

    const rowsBefore = await w.rows(id);
    const outside = await edit(itemId);
    expect(outside.status, await outside.clone().text()).toBe(missing.status);
    expect(await outside.json()).toEqual(await missing.json());
    expect(await w.rows(id)).toEqual(rowsBefore);
  });
});
