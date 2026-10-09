/**
 * R3-T02 PR-A 首个提交的冻结契约（设计 §1.2、§5.1）：qlReadable / qlStandardReadable 与 assertQualificationRefs。
 * - 读取 = 所属管理单元在范围内 ∪（向下公开 ∧ 范围内有其下级组织）；标准锚在类别上；
 * - 引用校验：没有查看权 403；不存在与范围外同一个 404；已停用 400 REFERENCE_DISABLED；
 * - PR-B / C1 / C2 只经这两个函数引用任职资格对象。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  assertQualificationRefs,
  type QualificationRefAccess,
} from '../../apps/api/src/modules/qualification/access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { createOrg, talentWorld, TC_NOW } from './AC-TC-support.js';

const testDb = useTestDb();

async function fixture(label: string) {
  const w = await talentWorld(testDb().db, label);
  const child = await createOrg(w.api, w.as, `${label}下级`, w.orgId);
  const other = await createOrg(w.api, w.as, `${label}其他`);
  const tx = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(testDb().db, w.tenant.id, work);
  const owner = w.as.user;
  /** 直接写库建对象（契约测试不依赖 PR-A 的接口）。 */
  const insert = async (orgId: string, extra: { enabled?: boolean; publicDown?: boolean } = {}) =>
    tx(async (t) => {
      const classId = randomUUID();
      const categoryId = randomUUID();
      const code = `C${randomUUID().slice(0, 8)}`;
      await t.execute(sql`INSERT INTO ql_category_classes (id, tenant_id, code, name, level, owner_id, owner_org_id,
        created_by) VALUES (${classId}, ${w.tenant.id}, ${`K${code}`}, '分类', 1, ${owner}, ${orgId}, ${owner})`);
      await t.execute(sql`INSERT INTO ql_categories (id, tenant_id, code, name, class_id, enabled, public_down,
        owner_id, owner_org_id, created_by) VALUES (${categoryId}, ${w.tenant.id}, ${code}, '类别', ${classId},
        ${extra.enabled ?? true}, ${extra.publicDown ?? false}, ${owner}, ${orgId}, ${owner})`);
      const levelId = randomUUID();
      await t.execute(sql`INSERT INTO ql_levels (id, tenant_id, code, name, display_order, owner_id, owner_org_id,
        created_by) VALUES (${levelId}, ${w.tenant.id}, ${`L${code}`}, '级别',
        ${Math.floor(Math.random() * 1e6)}, ${owner}, ${orgId}, ${owner})`);
      const standardId = randomUUID();
      await t.execute(sql`INSERT INTO ql_standards (id, tenant_id, category_id, name, level_ids, owner_id,
        owner_org_id, created_by) VALUES (${standardId}, ${w.tenant.id}, ${categoryId}, '标准',
        ${`{${levelId}}`}::uuid[], ${owner}, ${orgId}, ${owner})`);
      return { categoryId, levelId, standardId };
    });
  const ctx = { tenantId: w.tenant.id, now: TC_NOW, timezone: 'Asia/Shanghai' };
  const scoped = (orgIds: string[]): ModuleScope => ({
    ...EMPTY_SCOPE,
    orgIds,
    hasDataPermission: true,
    terms: undefined,
  });
  const access = (scope: ModuleScope | null): QualificationRefAccess => ({
    ctx,
    scopes: { category: scope, level: scope, target: scope, standard: scope },
  });
  return { w, child, other, tx, insert, scoped, access };
}

describe('PR-A 冻结契约：assertQualificationRefs', () => {
  it('DEC-281⑧ 范围内且启用通过；范围外与不存在同一个 404；没有查看权 403；停用 400', async () => {
    const { w, other, tx, insert, scoped, access } = await fixture('ql-refs-basic');
    const mine = await insert(w.orgId);
    const theirs = await insert(other);
    const disabled = await insert(w.orgId, { enabled: false });
    const inScope = access(scoped([w.orgId]));
    const check = (refs: Parameters<typeof assertQualificationRefs>[2], a = inScope) =>
      tx((t) => assertQualificationRefs(t, a, refs));

    await expect(
      check({ categoryIds: [mine.categoryId], levelIds: [mine.levelId], standardIds: [mine.standardId] }),
    ).resolves.toBeUndefined();
    const missing = randomUUID();
    for (const ids of [[theirs.categoryId], [missing]]) {
      await expect(check({ categoryIds: ids })).rejects.toMatchObject({ code: 'NOT_FOUND', message: '任职类别不存在' });
    }
    await expect(check({ standardIds: [theirs.standardId] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: '任职资格标准不存在',
    });
    await expect(check({ categoryIds: [mine.categoryId] }, access(null))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(check({ categoryIds: [disabled.categoryId] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'REFERENCE_DISABLED' },
    });
    // 空范围（缺省）一律不可见
    await expect(check({ levelIds: [mine.levelId] }, access(EMPTY_SCOPE))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('DEC-324② 向下公开：上级组织的类别打开向下公开后，下级范围的操作人可以引用；关闭时 404', async () => {
    const { w, child, tx, insert, scoped, access } = await fixture('ql-refs-public-down');
    const closed = await insert(w.orgId);
    const open = await insert(w.orgId, { publicDown: true });
    const childScope = access(scoped([child]));
    await expect(
      tx((t) =>
        assertQualificationRefs(t, childScope, { categoryIds: [open.categoryId], standardIds: [open.standardId] }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      tx((t) => assertQualificationRefs(t, childScope, { categoryIds: [closed.categoryId] })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
