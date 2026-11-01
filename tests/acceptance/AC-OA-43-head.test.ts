import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, expectError, headWorld } from './AC-OA-head-support.js';

const testDb = useTestDb();

describe('AC-OA-43 路由 1～3、7 按钮（§9.3）；提交 / 撤回路由 10c 起注册', () => {
  it('建单缺 AddAdjustOrgApprovalBtn、改头 / 校验缺 EditAdjustOrgDetailBtn、作废缺 OrganizationApprovalDelete → 403', async () => {
    const w = await headWorld(testDb().db, 'oa43h');
    const view = await w.created();
    const before = await w.count();
    w.access.deniedButtons = new Set(['AddAdjustOrgApprovalBtn']);
    await expectError(await w.create(), 403, 'FORBIDDEN');
    expect((await w.patch(view.id, { subject: '改头不需要新建按钮' })).status).toBe(200);
    w.access.deniedButtons = new Set(['EditAdjustOrgDetailBtn']);
    await expectError(await w.patch(view.id, { subject: 'x' }, 2), 403, 'FORBIDDEN');
    await expectError(await w.check(view.id), 403, 'FORBIDDEN');
    w.access.deniedButtons = new Set(['OrganizationApprovalDelete']);
    await expectError(await w.voidIt(view.id, 2), 403, 'FORBIDDEN');
    expect(await w.count()).toBe(before);
    expect(await w.stored(view.id)).toMatchObject({ approval_status: 0, revision: 2 });
    w.access.deniedButtons = new Set(['EditAdjustOrgDetailBtn', 'AddAdjustOrgApprovalBtn']);
    expect((await w.voidIt(view.id, 2)).status).toBe(200);
  });

  it('头字段无编辑权 → 403 整单拒绝；提交、撤回路由已注册（10c）', async () => {
    const w = await headWorld(testDb().db, 'oa43h');
    const view = await w.created();
    w.access.deniedFields = new Set(['content']);
    await expectError(await w.create(w.head()), 403, 'FORBIDDEN');
    await expectError(await w.patch(view.id, { content: '无权字段' }), 403, 'FORBIDDEN');
    const { content: _content, ...withoutContent } = w.head();
    expect((await w.create(withoutContent)).status).toBe(201);
    // 提交 / 撤回的行为见 AC-OA-12～15 / 26；这里核对路由已注册且走到业务关口：草稿提交在未发布流程时报流程未匹配
    // （提交路由不按头字段编辑权拦，DEC-017 同类型内不满足即报错），草稿撤回报不在审批中
    const post = (path: string) => w.call('POST', `${BASE}/${view.id}/${path}`, { ifMatch: 1, body: {} });
    await expectError(await post('submit'), 409, 'CONFLICT', 'APPROVAL_PROCESS_NOT_MATCHED');
    await expectError(await post('withdraw'), 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_IN_REVIEW');
    expect(await w.stored(view.id)).toMatchObject({ approval_status: 0, revision: 1 });
  });
});
