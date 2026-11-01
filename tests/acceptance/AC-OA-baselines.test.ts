import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assertBaselines } from '../../apps/api/src/modules/org-adjustment/baseline.js';
import { expectError } from './AC-OA-head-support.js';
import { itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';

const testDb = useTestDb();

describe('§2.5 基线（组织）：提交时判外部变更，刷新基线后通过', () => {
  it('目标组织被外部改动 → assertBaselines(submit) 409 BASELINE_CHANGED 列出行；单行刷新后通过', async () => {
    const w = await itemsWorld(testDb().db, 'oabase');
    const view = await w.created();
    const itemId = (await w.item(view.id, rename(w.a))).items[0]!.id;
    await w.item(view.id, newOrg(w.a));
    const judge = () => withTenant(w.db, w.tenant.id, (tx) => assertBaselines(tx, w.tenant.id, view.id, 'submit'));
    await expect(judge()).resolves.toBeUndefined();
    await w.touchOrg(w.a);
    await expect(judge()).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ORG_ADJUSTMENT_BASELINE_CHANGED', items: [{ section: 'org', itemId }] },
    });
    const revision = (await w.stored(view.id))!.revision;
    const res = await w.rebaseItem(view.id, itemId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await w.stored(view.id))!.revision).toBe(revision + 1);
    await expect(judge()).resolves.toBeUndefined();
    expect(await w.itemAudits(view.id)).toContain('org-adjustment.rebase');
  });

  it('新版本（负责人变更）→ 校验报 BASELINE_CHANGED；整单刷新覆盖全部行（含连带行）；暂存行不判', async () => {
    const w = await itemsWorld(testDb().db, 'oabase');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const head = await w.person('负责人', w.b);
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    await w.item(view.id, stop(w.a));
    await w.item(view.id, rename(w.b, { isStaged: true }));
    await w.setOrgRoles(child, { head: head.employeeId });
    await w.setOrgRoles(w.b, { head: head.employeeId });
    const result = await w.checked(view.id);
    const changed = result.errors.filter((e) => e.reason === 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect(changed.map((e) => e.orgId)).toEqual([child]);
    const before = (await w.rows(view.id)).find((r) => r.target_org_id === child)!.base_version_id;
    expect((await w.rebaseAll(view.id)).status).toBe(200);
    expect((await w.rows(view.id)).find((r) => r.target_org_id === child)!.base_version_id).not.toBe(before);
    expect((await w.checked(view.id)).errors.map((e) => e.reason)).not.toContain('ORG_ADJUSTMENT_BASELINE_CHANGED');
  });

  it('刷新：行不存在 → 404；新建行（无基线）刷新为空操作也 revision + 1；If-Match 过期 → 409', async () => {
    const w = await itemsWorld(testDb().db, 'oabase');
    const view = await w.created();
    const itemId = (await w.item(view.id, newOrg(w.a))).items[0]!.id;
    await expectError(await w.rebaseItem(view.id, randomUUID()), 404, 'NOT_FOUND');
    await expectError(await w.rebaseItem(view.id, itemId, undefined, 'position'), 404, 'NOT_FOUND');
    await expectError(await w.rebaseItem(view.id, itemId, 9), 409, 'REVISION_CONFLICT');
    expect((await w.rebaseItem(view.id, itemId)).status).toBe(200);
    expect((await w.stored(view.id))!.revision).toBe(3);
  });
});
