/**
 * BE-11b 执行侧：AC-OA-17（组织部分）未来生效日的单据执行后“已执行 / 成功”，当天看不到、生效日读回出现；
 * AC-OA-26（执行侧）审批后才直接改了目标组织（V1 → V2）→ 该组 ORG_ADJUSTMENT_BASELINE_CHANGED，不覆盖 V2（R2-T08 §2.5）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { E, execWorld } from './AC-OA-exec-support.js';
import { newOrg, rename, stop } from './AC-OA-items-support.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';

describe('AC-OA-17 未来生效（组织部分）', () => {
  it('E 在未来：执行后已执行 / 成功；当天组织视图仍是旧名、无新组织、仍启用，生效日读回新状态', async () => {
    const w = await execWorld(testDb().db, 'oa17-exec');
    const target = await w.org('ZZ_未来改名', w.a);
    const doomed = await w.org('ZZ_未来停用', w.a);
    const before = (await w.orgAt(target, TODAY))!.name;
    const adjustment = await w.approved(
      [w.a],
      [newOrg(w.a, { name: 'ZZ_未来新建' }), rename(target, { name: 'ZZ_未来新名' }), stop(doomed)],
    );

    await w.run();

    expect(await w.headRow(adjustment.id)).toMatchObject({ approval_status: 2, execution_status: 2, failure_count: 0 });
    const [created] = [...(await w.outcomes(adjustment.id)).values()];
    expect(created!.created_org_id).toEqual(expect.any(String));
    expect(await w.orgAt(created!.created_org_id!, TODAY)).toBeUndefined();
    expect(await w.orgAt(created!.created_org_id!)).toMatchObject({ name: 'ZZ_未来新建', parent_id: w.a });
    expect((await w.orgAt(target, TODAY))!.name).toBe(before);
    expect((await w.orgAt(target))!.name).toBe('ZZ_未来新名');
    expect((await w.orgAt(doomed, TODAY))!.enabled).toBe(true);
    expect((await w.orgAt(doomed))!.enabled).toBe(false);
  });
});

describe('AC-OA-26 执行侧基线', () => {
  it('同意后直接改了目标组织：该组 BASELINE_CHANGED、V2 不被覆盖，其余组照常；executed_version_id 只写成功组', async () => {
    const w = await execWorld(testDb().db, 'oa26-exec');
    const target = await w.org('ZZ_基线目标', w.a);
    const other = await w.org('ZZ_基线其他', w.a);
    const adjustment = await w.approved([w.a], [rename(target, { name: 'ZZ_单据名' }), rename(other)]);
    const v2 = await w.patchOrg(target, { name: 'ZZ_直接V2', effectiveDate: E, addEmployment: false });
    expect(v2.status, await v2.clone().text()).toBe(200);
    const versions = await w.versionCount(target);

    await w.run();

    const [changed, normal] = [...(await w.outcomes(adjustment.id)).values()];
    expect(changed).toMatchObject({
      execution_result: 2,
      execution_reason: 'ORG_ADJUSTMENT_BASELINE_CHANGED',
      executed_version_id: null,
    });
    expect(normal).toMatchObject({ execution_result: 1 });
    expect(normal!.executed_version_id).toBe((await w.orgAt(other))!.version_id);
    expect((await w.orgAt(target))!.name).toBe('ZZ_直接V2');
    expect(await w.versionCount(target)).toBe(versions);
    expect(await w.headRow(adjustment.id)).toMatchObject({ success_count: 1, failure_count: 1 });
  });
});
