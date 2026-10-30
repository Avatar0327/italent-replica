import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { expectError, headWorld, only } from './AC-OA-head-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

describe('AC-OA-42 调整范围（BE-10b1：数量 1～20 与所选组织授权，§5.6、§6.3 ②）', () => {
  it('去重后 1～20 个：0 个、21 个 → 400 ORG_ADJUSTMENT_RANGE_SIZE；20 个与重复选择通过', async () => {
    const w = await headWorld(testDb().db, 'oa42h');
    const twenty = [w.a, w.b];
    while (twenty.length < 20) twenty.push(await w.org(`范围${uniqueSuffix()}`));
    const before = await w.count();
    await expectError(
      await w.create(w.head({ adjustmentRange: [] })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_RANGE_SIZE',
    );
    await expectError(
      await w.create(w.head({ adjustmentRange: [...twenty, w.subject] })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_RANGE_SIZE',
    );
    await expectError(
      await w.create(w.head({ adjustmentRange: Array.from({ length: 21 }, () => randomUUID()) })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_RANGE_SIZE',
    );
    expect(await w.count()).toBe(before);
    const full = await w.created(w.head({ adjustmentRange: twenty }));
    expect(full.adjustmentRange).toEqual(twenty);
    const repeated = await w.created(w.head({ adjustmentRange: [...twenty, ...twenty, w.a] }));
    expect((await w.stored(repeated.id))?.range).toEqual(twenty);
    await expectError(
      await w.patch(full.id, { adjustmentRange: [] }),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_RANGE_SIZE',
    );
    expect(await w.stored(full.id)).toMatchObject({ revision: 1, range: twenty });
  });

  it('所选组织不在申请人组织对象范围 → 404（同无范围口径），不落库；主体组织不要求在组织对象范围', async () => {
    const w = await headWorld(testDb().db, 'oa42h');
    const view = await w.created();
    const before = await w.count();
    w.access.org = only(w.a);
    await expectError(await w.create(w.head({ adjustmentRange: [w.a, w.b] })), 404, 'NOT_FOUND');
    await expectError(await w.patch(view.id, { adjustmentRange: [w.a, w.b] }), 404, 'NOT_FOUND');
    expect(await w.count()).toBe(before);
    expect(await w.stored(view.id)).toMatchObject({ revision: 1, range: [w.a] });
    // 主体组织按申请单对象范围、调整范围按组织对象范围，两层各自判定
    w.access.main = only(w.subject);
    expect((await w.created(w.head({ adjustmentRange: [w.a] }))).adjustmentRange).toEqual([w.a]);
    // 未改范围的改头仍复核已选组织：申请人已失去该组织范围即拒绝
    w.access.org = only(w.b);
    await expectError(await w.patch(view.id, { subject: '只改主题' }), 404, 'NOT_FOUND');
    w.access.org = only(w.a);
    expect((await w.patch(view.id, { subject: '只改主题' })).status).toBe(200);
  });

  it('所选组织与主体组织须在生效日存在且启用：停用 / 未成立 / 不存在 → 400 ORG_ADJUSTMENT_ORG_INACTIVE', async () => {
    const w = await headWorld(testDb().db, 'oa42h');
    const view = await w.created();
    await w.disable(w.b);
    const before = await w.count();
    await expectError(
      await w.create(w.head({ adjustmentRange: [w.a, w.b] })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_ORG_INACTIVE',
    );
    await expectError(
      await w.create(w.head({ approvalSubjectOrgId: w.b })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_ORG_INACTIVE',
    );
    await expectError(
      await w.create(w.head({ effectiveDate: '2019-12-31' })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_ORG_INACTIVE',
    );
    await expectError(
      await w.create(w.head({ adjustmentRange: [randomUUID()] })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_ORG_INACTIVE',
    );
    await expectError(
      await w.patch(view.id, { adjustmentRange: [w.b] }),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_ORG_INACTIVE',
    );
    expect(await w.count()).toBe(before);
    // 只读校验：同一判定以信封返回，不写数据
    await w.disable(w.a);
    const res = await w.check(view.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      valid: false,
      errors: [{ reason: 'ORG_ADJUSTMENT_ORG_INACTIVE', orgIds: [w.a] }],
    });
    expect(await w.stored(view.id)).toMatchObject({ revision: 1, range: [w.a] });
    const ok = await w.created(w.head({ adjustmentRange: [w.subject] }));
    expect(await (await w.check(ok.id)).json()).toEqual({ valid: true, errors: [], warnings: [] });
  });
});
