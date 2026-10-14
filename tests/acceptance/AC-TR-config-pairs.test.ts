/**
 * R3-T04 PR-B1 第 2 轮：字段成对 / 审计 / 停用 / 存量补装（审查 P2-1～P2-4）：
 * - 成对是对“另一端”字段的修改：新建范围先于一切读取，另一端要有当前可见性与修改授权（数据操作权、update 按钮、
 *   pairFieldId 字段编辑权），看不到另一端的人无论目标是否存在、是否可配对都得到同一个 404（DEC-121 / 082）；
 * - 新建字段的创建审计在完整聚合（含初始选项）写入之后生成（DEC-216）；
 * - 已停用字段不能被新配对引用，已有配对之后停用仍保留（设计 §7 启停行）；
 * - 存量租户（B1 上线前开通）通过平台命令补装预置字段：幂等、不覆盖租户定制、只认平台运营身份（沿用 DEC-289③ 的回补形态）。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { and, auditEvents, eq, sql, talentReviewFieldOptions, talentReviewFields, withTenant } from '@italent/db';
import { TALENT_REVIEW_PRESET_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { configBody, configOperator, configWorld, type ConfigView, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { newUser, PLATFORM, provisioned, seedOperator } from './support/platform-api.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;
const numberField = (extra: Record<string, unknown> = {}) => configBody('field', { kind: 'number', ...extra });

interface FieldView extends ConfigView {
  readonly pairFieldId: string | null;
  readonly enabled: boolean;
}

describe('字段成对对另一端的授权（审查 P2-1；DEC-121 / 082）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const adminCreate = async (body: Record<string, unknown>) => {
    const response = await setup.request('POST', `${TR_BASE}/fields`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as FieldView;
  };
  const adminRead = async (id: string) =>
    (await (await setup.request('GET', `${TR_BASE}/fields/${id}`, world.asAdmin)).json()) as FieldView;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
  });

  it('数据范围为空的人：不存在的 / 可配对的 / 已被占用的另一端都得到同一个 404，另一端不变', async () => {
    const before = await adminCreate(numberField({ pairRole: 'before' }));
    const used = await adminCreate(numberField({ pairRole: 'before' }));
    await adminCreate(numberField({ pairRole: 'after', pairFieldId: used.id }));
    const used2 = await adminRead(used.id);
    const operator = await configOperator(world, 'field');
    const results = [];
    for (const pairFieldId of [randomUUID(), before.id, used.id]) {
      const response = await operator.request('POST', '/fields', {
        ifMatch: 0,
        body: numberField({ pairRole: 'after', pairFieldId }),
      });
      results.push([response.status, await response.json()]);
    }
    expect(results[0]![0]).toBe(404);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(await adminRead(before.id)).toEqual(before);
    expect(await adminRead(used.id)).toEqual(used2);
  });

  it('只有新建权、没有修改权：带配对的新建 403，另一端的 revision 不变；不带配对的新建正常', async () => {
    const before = await adminCreate(numberField({ pairRole: 'before' }));
    const operator = await configOperator(world, 'field', {
      seeAll: true,
      operations: { create: true, update: false, delete: false },
    });
    const paired = await operator.request('POST', '/fields', {
      ifMatch: 0,
      body: numberField({ pairRole: 'after', pairFieldId: before.id }),
    });
    expect([paired.status, await errorCode(paired)]).toEqual([403, 'FORBIDDEN']);
    expect(await adminRead(before.id)).toEqual(before);
    const plain = await operator.request('POST', '/fields', { ifMatch: 0, body: numberField() });
    expect(plain.status, await plain.clone().text()).toBe(201);
  });

  it('有修改权但没有 update 按钮：带配对的新建 403，另一端不变；补上按钮后可配对且另一端 revision +1', async () => {
    const before = await adminCreate(numberField({ pairRole: 'before' }));
    const operator = await configOperator(world, 'field', { seeAll: true, omitButtons: ['update'] });
    const body = numberField({ pairRole: 'after', pairFieldId: before.id });
    const denied = await operator.request('POST', '/fields', { ifMatch: 0, body });
    expect(denied.status).toBe(403);
    expect(await adminRead(before.id)).toEqual(before);
    await operator.setButtons(true, []);
    const created = await operator.request('POST', '/fields', { ifMatch: 0, body });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await adminRead(before.id)).toMatchObject({
      pairFieldId: ((await created.json()) as FieldView).id,
      revision: 2,
    });
  });
});

describe('新建字段的创建审计含初始选项（审查 P2-2；DEC-216）', () => {
  it.each(['option', 'multi_option'] as const)(
    '%s 字段（含成对一端）的创建审计 after / changes 带选项',
    async (kind) => {
      const w = await configWorld(testDb().db, `trc-audit-opt-${kind}`);
      const audit = auditApi(testDb().db, TR_NOW.toISOString());
      const options = [
        { value: '3', label: '高' },
        { value: '2', label: '中' },
      ];
      const before = await w.create('field', configBody('field', { kind, pairRole: 'before', options }));
      const after = await w.create(
        'field',
        configBody('field', { kind, pairRole: 'after', pairFieldId: before.id, options }),
      );
      const { items } = await audit.dataChanges(w.as, { objectType: 'TalentReview.Field', limit: '50' });
      for (const field of [before, after]) {
        const created = items.find((entry) => entry.objectId === field.id && entry.operation === 'create')!;
        expect(created.changes.map((change) => change.field)).toContain('options');
        const detail = await audit.dataChange(w.as, created.id);
        const snapshot = detail.after as { options: { value: string; label: string }[] };
        expect(snapshot.options.map((option) => option.value)).toEqual(['3', '2']);
      }
    },
  );
});

describe('已停用字段不能被新配对引用（审查 P2-3；设计 §7 启停行）', () => {
  it('两个方向都拒绝（400 PAIR_TARGET_DISABLED，另一端与字段数不变）；已有配对之后停用仍保留', async () => {
    const w = await configWorld(testDb().db, 'trc-pair-disabled');
    const count = async () =>
      ((await (await w.request('GET', '/fields?pageSize=100')).json()) as { items: unknown[] }).items.length;
    const lone = await w.create('field', numberField({ pairRole: 'before' }));
    expect((await w.request('PATCH', `/fields/${lone.id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(200);
    const total = await count();
    const disabledBefore = await w.read('field', lone.id);
    const toBefore = await w.request('POST', '/fields', {
      ifMatch: 0,
      body: numberField({ pairRole: 'after', pairFieldId: lone.id }),
    });
    expect([toBefore.status, await reasonOf(toBefore)]).toEqual([400, 'PAIR_TARGET_DISABLED']);
    const loneAfter = await w.create('field', numberField({ pairRole: 'after' }));
    await w.request('PATCH', `/fields/${loneAfter.id}`, { ifMatch: 1, body: { enabled: false } });
    const toAfter = await w.request('POST', '/fields', {
      ifMatch: 0,
      body: numberField({ pairRole: 'before', pairFieldId: loneAfter.id }),
    });
    expect([toAfter.status, await reasonOf(toAfter)]).toEqual([400, 'PAIR_TARGET_DISABLED']);
    expect(await count()).toBe(total + 1);
    expect((await w.read('field', lone.id)).body).toEqual(disabledBefore.body);

    const b = await w.create('field', numberField({ pairRole: 'before' }));
    const a = await w.create('field', numberField({ pairRole: 'after', pairFieldId: b.id }));
    const off = await w.request('PATCH', `/fields/${a.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect((await w.read('field', b.id)).body).toMatchObject({ pairFieldId: a.id });
    expect((await w.read('field', a.id)).body).toMatchObject({ pairFieldId: b.id, enabled: false });
  });
});

describe('存量租户补装 T04 预置字段（审查 P2-4；DEC-361 统一机制）', () => {
  const rows = (tenant: string) =>
    withTenant(testDb().db, tenant, (tx) =>
      tx
        .select({
          code: talentReviewFields.code,
          name: talentReviewFields.name,
          enabled: talentReviewFields.enabled,
          sortNo: talentReviewFields.sortNo,
          pairFieldId: talentReviewFields.pairFieldId,
        })
        .from(talentReviewFields)
        .where(eq(talentReviewFields.preset, true)),
    );
  const createAudits = (tenant: string) =>
    withTenant(testDb().db, tenant, (tx) =>
      tx
        .select({ objectId: auditEvents.objectId })
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, 'talent-review.field.create'), eq(auditEvents.objectType, 'TalentReview.Field')),
        ),
    );
  /** 模拟 B1 上线前开通的租户：删掉指定预置字段（只删不成对的），再做租户定制。 */
  async function legacyTenant(label: string) {
    const db = testDb().db;
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, `ops-${label}`);
    const admin = await newUser(db, `admin-${label}`);
    const exception = await newUser(db, `exception-${label}`);
    const result = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exception.id,
      licenses: [{ licenseType: 'core_hr', quota: 10 }],
    });
    const tenant = result.tenant.id;
    await withTenant(db, tenant, async (tx) => {
      await tx.execute(sql`DELETE FROM talent_review_forms`); // PR-B3：预置表单引用预置字段（restrict）
      // B2 起开通会下发引用“标签”的预置映射；B2 之前开通的租户没有它，模拟时一并清掉才能删字段
      await tx.execute(sql`DELETE FROM talent_review_field_mappings`);
      await tx.execute(sql`DELETE FROM talent_review_fields WHERE code IN ('tags', 'strengths', 'development_areas')`);
      await tx.execute(
        sql`UPDATE talent_review_fields SET name = '自定义备注', enabled = false, sort_no = 99 WHERE code = 'remark'`,
      );
    });
    return { api, operator, admin, tenant };
  }
  const backfill = (api: ReturnType<typeof tenantApi>, user: string, tenant: string, body = {}, extra = {}) =>
    api.request('POST', `${PLATFORM}/tenants/${tenant}/seeds/backfill`, { user, body, ...extra });
  type Report = { items: { module: string; key: string; installed: string[]; existing: number }[] };

  it('25 个预置字段齐全（含选项与配对）；已定制 / 改名 / 停用的不被覆盖；重复回补无变化；写审计；无平台权限拒绝', async () => {
    const t = await legacyTenant('trc-backfill');
    const other = await legacyTenant('trc-backfill-other');
    const total = TALENT_REVIEW_PRESET_FIELDS.length;
    expect(await rows(t.tenant)).toHaveLength(total - 3);
    const denied = await backfill(t.api, t.admin.id, t.tenant);
    expect(denied.status).toBe(403);
    expect(await rows(t.tenant)).toHaveLength(total - 3);

    const auditedBefore = (await createAudits(t.tenant)).length;
    const first = await backfill(t.api, t.operator.id, t.tenant, { modules: ['talent-review'] });
    expect(first.status, await first.clone().text()).toBe(200);
    const report = ((await first.json()) as Report).items.find((item) => item.key === 'preset-fields')!;
    expect(report).toMatchObject({ module: 'talent-review', existing: total - 3 });
    expect([...report.installed].sort()).toEqual(['development_areas', 'strengths', 'tags']);
    const after = await rows(t.tenant);
    expect(after).toHaveLength(total);
    expect(after.find((row) => row.code === 'remark')).toMatchObject({
      name: '自定义备注',
      enabled: false,
      sortNo: 99,
    });
    expect(after.filter((row) => row.pairFieldId !== null)).toHaveLength(
      TALENT_REVIEW_PRESET_FIELDS.filter((preset) => preset.pairCode).length,
    );
    expect(await createAudits(t.tenant)).toHaveLength(auditedBefore + 3);

    const again = (await (
      await backfill(t.api, t.operator.id, t.tenant, { modules: ['talent-review'] })
    ).json()) as Report;
    expect(again.items.find((item) => item.key === 'preset-fields')).toMatchObject({ installed: [], existing: total });
    expect(await rows(t.tenant)).toEqual(after);
    expect(await createAudits(t.tenant)).toHaveLength(auditedBefore + 3);
    expect(await rows(other.tenant)).toHaveLength(total - 3);
  });

  it('补装全空租户：25 个字段连同选项、配对关系一次装齐（与开通同一安装逻辑）', async () => {
    const t = await legacyTenant('trc-backfill-empty');
    await withTenant(testDb().db, t.tenant, async (tx) => {
      await tx.execute(sql`DELETE FROM talent_review_forms`); // PR-B3：预置表单引用预置字段（restrict）
      await tx.execute(sql`DELETE FROM talent_review_field_mappings`);
      await tx.execute(sql`DELETE FROM talent_review_matrices`); // PR-B4：预置九宫格引用预置字段（restrict）
      await tx.execute(sql`UPDATE talent_review_fields SET pair_field_id = NULL`);
      await tx.execute(sql`DELETE FROM talent_review_fields`);
    });
    expect(await rows(t.tenant)).toHaveLength(0);
    const response = await backfill(t.api, t.operator.id, t.tenant, { modules: ['talent-review'] });
    expect(response.status, await response.clone().text()).toBe(200);
    const filled = await rows(t.tenant);
    expect(filled).toHaveLength(TALENT_REVIEW_PRESET_FIELDS.length);
    const paired = TALENT_REVIEW_PRESET_FIELDS.filter((preset) => preset.pairCode).length;
    expect(filled.filter((row) => row.pairFieldId !== null)).toHaveLength(paired);
    const options = await withTenant(testDb().db, t.tenant, (tx) => tx.select().from(talentReviewFieldOptions));
    const expected = TALENT_REVIEW_PRESET_FIELDS.reduce((sum, preset) => sum + (preset.options?.length ?? 0), 0);
    expect(options).toHaveLength(expected);
  });
});
