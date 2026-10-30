import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type AdjustmentView, expectError, headWorld, only } from './AC-OA-head-support.js';

const testDb = useTestDb();

describe('AC-OA-24 头写入（BE-10b1：建单 / 改头 / 作废，§6.1、§3）', () => {
  it('建单：头字段落库、范围去重保序、编码系统生成、状态 0、revision 1、同事务审计', async () => {
    const w = await headWorld(testDb().db, 'oa24h');
    const res = await w.create(w.head({ adjustmentRange: [w.b, w.a, w.b], content: '  说明  ' }));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    const view = (await res.json()) as AdjustmentView;
    expect(view).toMatchObject({
      approvalSubjectOrgId: w.subject,
      adjustmentRange: [w.b, w.a],
      effectiveDate: '2026-11-01',
      approvalStatus: 0,
      executionStatus: 1,
      revision: 1,
    });
    expect(view.code).toMatch(/^OA\d{8}\d{4}$/);
    const row = await w.stored(view.id);
    expect(row).toMatchObject({
      code: view.code,
      subject: view.subject,
      effective_date: '2026-11-01',
      approval_subject_org_id: w.subject,
      approval_status: 0,
      revision: 1,
      created_by: w.hr.id,
      range: [w.b, w.a],
    });
    expect(await w.audits(view.id)).toEqual(['org-adjustment.create']);
    const second = await w.created();
    expect(second.code).not.toBe(view.code);
  });

  it('改头：只在 0 / 6，revision + 1、范围整体替换；旧 revision 409、缺 If-Match 400', async () => {
    const w = await headWorld(testDb().db, 'oa24h');
    const view = await w.created();
    const res = await w.patch(view.id, { subject: '新主题', adjustmentRange: [w.b, w.a] }, 1);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toMatchObject({ subject: '新主题', adjustmentRange: [w.b, w.a], revision: 2 });
    expect(await w.stored(view.id)).toMatchObject({ subject: '新主题', revision: 2, range: [w.b, w.a] });
    await expectError(await w.patch(view.id, { subject: '旧版本' }, 1), 409, 'REVISION_CONFLICT');
    await expectError(await w.patch(view.id, { subject: '缺版本' }, null), 400, 'REVISION_REQUIRED');
    await w.setStatus(view.id, 6);
    expect((await w.patch(view.id, { content: null }, 2)).status).toBe(200);
    expect(await w.stored(view.id)).toMatchObject({ content: null, revision: 3, approval_status: 6 });
    expect(await w.audits(view.id)).toEqual([
      'org-adjustment.create',
      'org-adjustment.update',
      'org-adjustment.update',
    ]);
  });

  it('作废：0 / 6 → 5，不物理删除；作废后与审批中、终态都不能改头 / 再作废', async () => {
    const w = await headWorld(testDb().db, 'oa24h');
    const view = await w.created();
    const res = await w.voidIt(view.id, 1);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ approvalStatus: 5, revision: 2 });
    expect(await w.stored(view.id)).toMatchObject({ approval_status: 5, revision: 2, range: [w.a] });
    await expectError(await w.patch(view.id, { subject: 'x' }, 2), 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_EDITABLE');
    await expectError(await w.voidIt(view.id, 2), 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_EDITABLE');
    const reviewing = await w.created();
    await w.setStatus(reviewing.id, 1);
    await expectError(await w.patch(reviewing.id, { subject: 'x' }), 409, 'CONFLICT', 'ORG_ADJUSTMENT_IN_REVIEW');
    await expectError(await w.voidIt(reviewing.id), 409, 'CONFLICT', 'ORG_ADJUSTMENT_IN_REVIEW');
    for (const status of [2, 3, 4]) {
      await w.setStatus(reviewing.id, status);
      await expectError(await w.patch(reviewing.id, { subject: 'x' }), 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_EDITABLE');
    }
    expect(await w.stored(reviewing.id)).toMatchObject({ revision: 1, range: [w.a] });
    const rejected = await w.created();
    await w.setStatus(rejected.id, 6);
    expect((await w.voidIt(rejected.id)).status).toBe(200);
    expect(await w.audits(view.id)).toEqual(['org-adjustment.create', 'org-adjustment.void']);
  });

  it('主体组织在申请单对象范围外：建单 / 改头 / 作废 / 校验均 404，数据不变', async () => {
    const w = await headWorld(testDb().db, 'oa24h');
    const view = await w.created();
    const before = await w.count();
    w.access.main = only(w.a);
    await expectError(await w.create(), 404, 'NOT_FOUND');
    await expectError(await w.patch(view.id, { subject: '越权' }), 404, 'NOT_FOUND');
    await expectError(await w.voidIt(view.id), 404, 'NOT_FOUND');
    await expectError(await w.check(view.id), 404, 'NOT_FOUND');
    expect(await w.count()).toBe(before);
    expect(await w.stored(view.id)).toMatchObject({ approval_status: 0, revision: 1, subject: view.subject });
    // 改头把主体换到范围外组织同样拒绝：新旧两侧都判
    w.access.main = only(w.subject);
    await expectError(await w.patch(view.id, { approvalSubjectOrgId: w.a }), 404, 'NOT_FOUND');
    expect(await w.stored(view.id)).toMatchObject({ approval_subject_org_id: w.subject, revision: 1 });
    // 不存在的单据与范围外同码
    await expectError(await w.patch(randomUUID(), { subject: 'x' }), 404, 'NOT_FOUND');
  });

  it('只有申请人能改头 / 作废；头字段格式非法 400 且不落库', async () => {
    const w = await headWorld(testDb().db, 'oa24h');
    const view = await w.created();
    const other = await w.member('非申请人');
    await expectError(
      await w.patch(view.id, { subject: 'x' }, 1, other),
      403,
      'FORBIDDEN',
      'ORG_ADJUSTMENT_NOT_APPLICANT',
    );
    await expectError(await w.voidIt(view.id, 1, other), 403, 'FORBIDDEN', 'ORG_ADJUSTMENT_NOT_APPLICANT');
    const before = await w.count();
    for (const bad of [
      { subject: '   ' },
      { subject: '字'.repeat(101) },
      { effectiveDate: '2026-02-30' },
      { effectiveDate: '20261101' },
      { content: '字'.repeat(1001) },
      { approvalSubjectOrgId: 'not-a-uuid' },
      { adjustmentRange: ['not-a-uuid'] },
      { approvalSubjectOrgId: undefined },
      { unknownField: 1 },
    ])
      await expectError(await w.create(w.head(bad)), 400, 'VALIDATION_FAILED');
    await expectError(await w.patch(view.id, {}), 400, 'VALIDATION_FAILED');
    expect(await w.count()).toBe(before);
    expect((await w.created(w.head({ subject: '字'.repeat(100), content: '字'.repeat(1000) }))).subject).toHaveLength(
      100,
    );
  });
});
