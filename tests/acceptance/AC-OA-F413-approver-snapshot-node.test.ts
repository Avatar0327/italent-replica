/**
 * F-413（R2-T08 §4.5，BE-10c / 10d）：组织调整读接口的审批人路径与审批中心同源——字段集取“业务快照 + 查看人所在节点”
 * （`viewerNode`：自己参与的最后一个节点 → 被抄送节点 → 当前节点），而不是读接口自己再拼一遍。
 * 已办的审批人驳回 / 修改明细后仍按其办理过的节点披露，当前待办人按当前节点披露；两条读路径对同一查看人给出同一字段集。
 */
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes, type FlowWorld } from './AC-OA-approval-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rename } from './AC-OA-items-support.js';
import { reader } from './AC-OA-read-support.js';

const testDb = useTestDb();
/** 第二个节点不勾 subject / 名称：与第一个节点的披露集不同，才能区分“按哪个节点判”。 */
const N2_HIDDEN = new Set(['subject', 'orgItems.name']);
const nodes = () => oaNodes([{}, { formFields: ORG_ADJUSTMENT_FORM_FIELDS.filter((code) => !N2_HIDDEN.has(code)) }]);

/**
 * 读接口（详情 + 明细）与审批中心详情各自给出的“本人看得到”的字段。审批人不是 HR：读接口期间临时收回对象查看权与范围，
 * 只能走审批人路径；读完恢复，后面的 HR 写操作照常。
 */
async function seen(w: FlowWorld, id: string, userId: string) {
  const r = reader(w);
  const saved = { viewDenied: w.access.viewDenied, main: w.access.main, org: w.access.org };
  Object.assign(w.access, { viewDenied: true, main: EMPTY_SCOPE, org: EMPTY_SCOPE });
  try {
    const detail = await r.detail(id, userId);
    const items = await r.items(id, userId);
    const center = (await w.detail((await w.instance(id)).id, userId)).form.values;
    return {
      subject: 'subject' in detail,
      names: items.items.map((item) => item.name),
      centerSubject: 'subject' in center,
      centerNames: center['orgItems.name'] as { value: unknown }[] | undefined,
    };
  } finally {
    Object.assign(w.access, saved);
  }
}

describe('F-413 审批人路径按审批中心同一节点判定', () => {
  it('已办人按其办理的节点、当前待办人按当前节点披露；驳回并改明细后仍如此，且与审批中心一致', async () => {
    const w = await flowWorld(testDb().db, 'f413-node', { nodes: nodes() });
    const { id, itemId } = await w.draft(rename(w.a, { name: 'ZZ_原名' }));
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'approve');

    // 审批中：hrbp 已办（办理的是 n1，勾了名称），head 是当前待办人（当前节点 n2，没勾名称）
    const hrbp = await seen(w, id, w.hrbp.userId);
    expect(hrbp).toMatchObject({ subject: true, names: ['ZZ_原名'], centerSubject: true });
    const head = await seen(w, id, w.head.userId);
    expect(head).toMatchObject({ subject: false, centerSubject: false });
    expect(head.names.every((name) => name === undefined)).toBe(true);
    expect(head.centerNames).toBeUndefined();

    // 驳回、修改明细后：两人仍按各自办理的节点；已办人看到的就是审批中心里同一份内容
    await w.acted(id, w.head, 'reject');
    const patched = await w.patchItem(id, itemId, { name: 'ZZ_改后名' });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const hrbpAfter = await seen(w, id, w.hrbp.userId);
    expect(hrbpAfter.subject).toBe(true);
    expect(hrbpAfter.names).toEqual(hrbpAfter.centerNames!.map((entry) => entry.value));
    const headAfter = await seen(w, id, w.head.userId);
    expect(headAfter).toMatchObject({ subject: false, centerSubject: false });
    expect(headAfter.names.every((name) => name === undefined)).toBe(true);
  });
});
