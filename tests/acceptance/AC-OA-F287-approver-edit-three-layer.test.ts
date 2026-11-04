/**
 * F-287（DEC-644 A-3，R2-T08 §6.3 OA-R7）：审批中编辑与“编辑并同意”按当前节点审批人自己的三层范围取严，
 * 主体组织同样须在审批人的 OrganizationApproval 范围，不因“审批实例可打开”而豁免：
 * - 主体层：只改明细字段（不碰头）也要判主体组织；
 * - 明细组织层：所改行涉及的组织须在审批人的组织对象范围；
 * - 范围内正向对照：同一审批人、同一编辑，范围够时照常生效。
 * 拒绝路径下头 / 明细 / revision / 实例业务版本 / 待办都不变；审批人仍可读本单（canOpen 只放行读）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type FlowWorld, flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { only } from './AC-OA-head-support.js';

const testDb = useTestDb();
/** 独立编辑（edit）与编辑并同意（approve）是两种节点编辑方式，各开一个世界。 */
const ROUTES = [
  ['edit', 'separate'],
  ['approve', 'with_approve'],
] as const;
const nodes = (editMode: 'separate' | 'with_approve') =>
  oaNodes([{ editMode, editableFields: ['subject', 'orgItems.name'] }]);
const RENAMED = 'ZZ_审批人改名';

async function unchanged(w: FlowWorld, id: string) {
  const view = await w.instance(id);
  return {
    stored: await w.stored(id),
    rows: await w.rows(id),
    state: await w.state(id),
    businessVersion: await w.businessVersion(id),
    pending: view.tasks.filter((t) => t.status === 'pending').map((t) => [t.nodeKey, t.assigneeUserId]),
  };
}

const rejected = (res: Response) => expect([403, 404]).toContain(res.status);

describe.each(ROUTES)('F-287 审批中编辑（%s）：主体组织层', (action, mode) => {
  it('只改明细名称、主体组织不在审批人 OrganizationApproval 范围 → 被拒，单据不动；仍可读', async () => {
    const w = await flowWorld(testDb().db, `f287-subject-${action}`, { nodes: nodes(mode) });
    const { id, itemId } = await w.draft();
    await w.submitted(id);
    w.access.main = only(w.b);
    const before = await unchanged(w, id);

    rejected(await w.act(id, w.hrbp, action, { fields: { 'orgItems.name': [{ itemId, value: RENAMED }] } }));

    expect(await unchanged(w, id)).toEqual(before);
    expect((await w.detail((await w.instance(id)).id, w.hrbp.userId)).form.values).toHaveProperty('orgItems.name');
  });

  it('正向对照：主体组织在审批人范围内 → 同一编辑生效，revision + 1、实例业务版本同步', async () => {
    const w = await flowWorld(testDb().db, `f287-subject-in-${action}`, { nodes: nodes(mode) });
    const { id, itemId } = await w.draft();
    await w.submitted(id);
    w.access.main = only(w.subject);
    const revision = (await w.state(id)).revision;

    const res = await w.act(id, w.hrbp, action, { fields: { 'orgItems.name': [{ itemId, value: RENAMED }] } });

    expect(res.status, await res.clone().text()).toBe(200);
    expect((await w.rows(id))[0]!.name).toBe(RENAMED);
    expect((await w.state(id)).revision).toBe(revision + 1);
    expect(await w.businessVersion(id)).toBe(`revision:${revision + 1}`);
  });
});

describe.each(ROUTES)('F-287 审批中编辑（%s）：明细组织层', (action, mode) => {
  it('主体组织在范围内、所改行的目标组织不在审批人组织对象范围 → 被拒，单据不动；范围含目标则生效', async () => {
    const w = await flowWorld(testDb().db, `f287-detail-${action}`, { nodes: nodes(mode) });
    const { id, itemId } = await w.draft();
    await w.submitted(id);
    w.access.main = only(w.subject);
    w.access.org = only(w.subject, w.b);
    const before = await unchanged(w, id);
    const fields = { 'orgItems.name': [{ itemId, value: RENAMED }] };

    rejected(await w.act(id, w.hrbp, action, { fields }));
    expect(await unchanged(w, id)).toEqual(before);

    w.access.org = only(w.subject, w.a);
    const ok = await w.act(id, w.hrbp, action, { fields });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.rows(id))[0]!.name).toBe(RENAMED);
  });
});
