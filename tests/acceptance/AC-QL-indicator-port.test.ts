/**
 * R3-T02 C1-3 QualificationIndicatorPort 的实现与登记（设计 §6.2 (1)，DEC-317④、DEC-320⑥，Q-T02-16 ①；拆分方案 C1-3）：
 * - indicators：员工当前资格 → 类别标准 → 当前级别那一列的指标；内容不裁剪（可信端口，调用方按自己的业务关系授权）；
 *   三种失败原因 no_current_qualification / no_standard / level_not_in_standard；filter 按指标类型（含下级类型）/ 指标；
 * - listTargetTypes / listTargets：调用方的范围谓词在分页之前生效（qualificationReadableSql）；
 * - 返回值各层 readonly；有界（单次 ≤ 500）；只读不写。
 * 未登记时 T04 得 INDICATOR_SOURCE_UNAVAILABLE 属 R3-T04 的约定，见 AC-QL-contract（登记表）。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { qualificationIndicatorPort, type QualificationIndicatorPort } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { currentWorld } from './AC-QL-current-support.js';
import { createOrg } from './AC-TC-support.js';
import { QL_NOW, type GradeSchemeView, type StandardView } from './AC-QL-support.js';
import { qualificationReadableSql } from '../../apps/api/src/modules/qualification/indicator-port.js';

const database = useTestDb();

function port(): QualificationIndicatorPort {
  const registered = qualificationIndicatorPort();
  expect(registered, '端口应在模块加载时登记').toBeTruthy();
  return registered!;
}

async function portWorld(label: string) {
  const world = await currentWorld(database, label);
  const { w, category, p1, p2 } = world;
  const rootType = await w.targetType({ code: 'TA', name: '专业能力' });
  const childType = await w.targetType({ code: 'TA1', name: '编程', parentId: rootType.id });
  const otherType = await w.targetType({ code: 'TB', name: '通用素质' });
  const plain = await w.target(childType.id, { code: 'Z1', name: '代码质量', description: '说明 1' });
  const common = await w.target(rootType.id, {
    code: 'Z2',
    name: '沟通协作',
    description: '通用说明',
    isCommon: true,
    confirmOverwrite: true,
  });
  const scheme = await w.gradeScheme([
    { name: '初级', grade: 1, description: '初级描述' },
    { name: '高级', grade: 2, description: '高级描述' },
  ]);
  const graded = await w.target(otherType.id, {
    code: 'Z3',
    name: '领导力',
    evalMode: 'grade',
    gradeSchemeId: scheme.id,
  });
  const grade = (scheme as GradeSchemeView).details[1]!;
  const standard = await w.standard({
    categoryId: category.id,
    levelIds: [p1.id, p2.id],
    details: [
      {
        levelId: p1.id,
        targetId: plain.id,
        targetValue: '3',
        weight: 40,
        abilities: [{ content: '能写出可读代码', targetValue: '3' }, { content: '会做代码评审' }],
      },
      { levelId: p1.id, targetId: common.id, weight: 30 },
      {
        levelId: p1.id,
        targetId: graded.id,
        weight: 30,
        abilities: [{ content: '带过 5 人团队', targetGradeId: grade.id }],
      },
      { levelId: p2.id, targetId: plain.id, weight: 100 },
    ],
  });
  return {
    ...world,
    rootType,
    childType,
    otherType,
    plain,
    common,
    graded,
    scheme,
    grade,
    standard: standard as StandardView,
  };
}

describe('AC-QL-indicator-port indicators：当前资格 → 标准 → 当前级别的指标（内容不裁剪）', () => {
  it('返回类别 / 级别与当前级别列的全部指标，字段齐全；顺序 = 指标顺序号、编码', async () => {
    const f = await portWorld('qi-ok');
    const id = await f.employee();
    await f.record(id, { startDate: '2026-01-01' });
    const outcome = await f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-06-01'));
    expect(outcome).toMatchObject({ ok: true, categoryId: f.category.id, levelId: f.p1.id });
    if (!outcome.ok) return;
    expect(outcome.data.map((item) => item.code)).toEqual(['Z1', 'Z2', 'Z3']);
    expect(outcome.data[0]).toEqual({
      targetId: f.plain.id,
      code: 'Z1',
      name: '代码质量',
      targetTypeId: f.childType.id,
      targetTypePath: ['专业能力', '编程'],
      evalMode: 'score',
      gradeSchemeId: null,
      weight: 40,
      targetValue: '3',
      abilities: [
        { content: '能写出可读代码', targetValue: '3', targetGradeId: null },
        { content: '会做代码评审', targetValue: null, targetGradeId: null },
      ],
      enabled: true,
    });
    expect(outcome.data[1]).toMatchObject({
      code: 'Z2',
      targetTypePath: ['专业能力'],
      weight: 30,
      targetValue: null,
      abilities: [{ content: '通用说明', targetValue: null, targetGradeId: null }],
    });
    expect(outcome.data[2]).toMatchObject({
      code: 'Z3',
      evalMode: 'grade',
      gradeSchemeId: f.scheme.id,
      abilities: [{ content: '带过 5 人团队', targetGradeId: f.grade.id }],
    });
  });

  it('按 asOf 取当时的级别：换到二级后只剩二级那一列', async () => {
    const f = await portWorld('qi-asof');
    const id = await f.employee();
    await f.record(id, { startDate: '2025-01-01', endDate: '2025-12-31' });
    await f.record(id, { levelId: f.p2.id, startDate: '2026-01-01' });
    const at = (asOf: string) => f.tx((t) => port().indicators(t, f.w.tenant.id, id, asOf));
    const first = await at('2025-06-01');
    const second = await at('2026-06-01');
    expect(first.ok && first.levelId).toBe(f.p1.id);
    expect(second.ok && second.levelId).toBe(f.p2.id);
    expect(second.ok && second.data.map((item) => item.code)).toEqual(['Z1']);
  });

  it('停用的指标照样返回并带 enabled=false（调用方自行判断）；内容不按字段权限裁剪', async () => {
    const f = await portWorld('qi-disabled');
    const id = await f.employee();
    await f.record(id);
    const patched = await f.w.request('PATCH', `/targets/${f.plain.id}`, {
      ifMatch: f.plain.revision,
      body: { enabled: false },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const outcome = await f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-06-01'));
    expect(outcome.ok && outcome.data.find((item) => item.code === 'Z1')).toMatchObject({
      enabled: false,
      abilities: [{ content: '能写出可读代码' }, { content: '会做代码评审' }],
    });
  });

  it('三种失败原因：无当前资格 / 类别没有标准 / 当前级别不在标准里', async () => {
    const f = await portWorld('qi-fail');
    const at = (id: string) => f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-06-01'));
    const none = await f.employee();
    expect(await at(none)).toEqual({ ok: false, reason: 'no_current_qualification' });
    const ended = await f.employee();
    await f.record(ended, { startDate: '2025-01-01', endDate: '2025-03-31' });
    expect(await at(ended)).toEqual({ ok: false, reason: 'no_current_qualification' });

    const noStandard = await f.employee();
    await f.record(noStandard, { categoryId: f.otherCategory.id });
    expect(await at(noStandard)).toEqual({ ok: false, reason: 'no_standard' });

    const outOfRange = await f.employee();
    await f.record(outOfRange, { levelId: f.p3.id });
    expect(await at(outOfRange)).toEqual({ ok: false, reason: 'level_not_in_standard' });
  });

  it('当前级别在标准范围内但这一列没有指标 → ok，data 为空', async () => {
    const f = await portWorld('qi-empty-column');
    const klass = f.klass;
    const category = await f.w.category(klass.id);
    await f.w.standard({ categoryId: category.id, levelIds: [f.p1.id, f.p2.id], details: [] });
    const id = await f.employee();
    await f.record(id, { categoryId: category.id });
    expect(await f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-06-01'))).toEqual({
      ok: true,
      categoryId: category.id,
      levelId: f.p1.id,
      data: [],
    });
  });

  it('filter：targetIds；targetTypeIds 含下级类型；两者同时给取交集', async () => {
    const f = await portWorld('qi-filter');
    const id = await f.employee();
    await f.record(id);
    const run = (filter: { targetTypeIds?: string[]; targetIds?: string[] }) =>
      f.tx(async (t) => {
        const outcome = await port().indicators(t, f.w.tenant.id, id, '2026-06-01', filter);
        return outcome.ok ? outcome.data.map((item) => item.code) : outcome;
      });
    expect(await run({ targetIds: [f.graded.id] })).toEqual(['Z3']);
    expect(await run({ targetTypeIds: [f.rootType.id] })).toEqual(['Z1', 'Z2']);
    expect(await run({ targetTypeIds: [f.childType.id] })).toEqual(['Z1']);
    expect(await run({ targetTypeIds: [f.rootType.id], targetIds: [f.common.id, f.graded.id] })).toEqual(['Z2']);
    expect(await run({ targetTypeIds: [randomUUID()] })).toEqual([]);
    expect(await run({})).toEqual(['Z1', 'Z2', 'Z3']);
    // 给了空数组 = 什么都不要（不是“不过滤”）
    expect(await run({ targetIds: [] })).toEqual([]);
    expect(await run({ targetTypeIds: [] })).toEqual([]);
  });

  it('返回值各层 readonly（冻结）：调用方不能就地改写', async () => {
    const f = await portWorld('qi-frozen');
    const id = await f.employee();
    await f.record(id);
    const outcome = await f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-06-01'));
    if (!outcome.ok) throw new Error('应成功');
    const item = outcome.data[0]! as unknown as {
      name: string;
      abilities: { content: string }[];
      targetTypePath: string[];
    };
    expect(() => {
      item.name = '改名';
    }).toThrow();
    expect(() => {
      item.abilities[0]!.content = '改写';
    }).toThrow();
    expect(() => item.targetTypePath.push('x')).toThrow();
    expect(() => (outcome.data as unknown[]).push({})).toThrow();
  });

  it('只读：不写任何表；asOf 不合法抛错', async () => {
    const f = await portWorld('qi-readonly');
    const id = await f.employee();
    await f.record(id);
    const counts = () =>
      f.count(sql`SELECT (SELECT count(*) FROM personnel_qualification) + (SELECT count(*) FROM audit_events) AS n`);
    const before = await counts();
    await f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-06-01'));
    expect(await counts()).toBe(before);
    await expect(f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-13-40'))).rejects.toThrow();
  });
});

describe('AC-QL-indicator-port listTargetTypes / listTargets：调用方范围谓词在分页之前生效', () => {
  async function typeWorld(label: string) {
    const f = await portWorld(label);
    const { w, tx } = f;
    const otherOrg = await createOrg(w.api, w.as, `${label}其他部`);
    const seeded: { id: string; org: 'own' | 'other' }[] = [];
    // 顺序号 100.. 起：自己组织与其他组织交替，保证“先分页后过滤”会漏
    for (const [index, org] of (['own', 'other', 'own', 'other', 'own', 'other'] as const).entries()) {
      const id = randomUUID();
      seeded.push({ id, org });
      await tx((t) =>
        t.execute(sql`INSERT INTO ql_target_types
          (id, tenant_id, code, name, display_order, enabled, owner_id, owner_org_id, created_by)
          VALUES (${id}::uuid, ${w.tenant.id}, ${`SC${index}`}, ${`范围类型${index}`}, ${100 + index}, true,
            ${w.user.id}, ${org === 'own' ? w.orgId : otherOrg}, ${w.user.id})`),
      );
    }
    const scopeOf = (orgIds: string[]) => ({
      orgIds,
      personIds: [],
      all: false,
      hasDataPermission: true,
      terms: [{ dimension: 'management' as const, orgIds, personIds: [] }],
    });
    const predicate = (orgIds: string[]) =>
      qualificationReadableSql(
        { tenantId: w.tenant.id, now: QL_NOW, timezone: 'Asia/Shanghai' },
        scopeOf(orgIds),
        'targetType',
      );
    return { ...f, otherOrg, seeded, predicate };
  }

  it('范围外的指标类型不出现，且分页按过滤后的结果切（不是先切页再过滤）', async () => {
    const f = await typeWorld('ql-list-scope');
    const own = f.seeded.filter((item) => item.org === 'own').map((item) => item.id);
    const page = (limit: number, offset: number) =>
      f.tx(async (t) => {
        const types = await port().listTargetTypes(t, f.w.tenant.id, f.predicate([f.w.orgId]), { limit, offset });
        return types.map((item) => item.id).filter((id) => f.seeded.some((s) => s.id === id));
      });
    // 夹具之外还有 portWorld 建的 3 个本组织类型（顺序号 0），排在前面
    const all = await f.tx(async (t) =>
      (await port().listTargetTypes(t, f.w.tenant.id, f.predicate([f.w.orgId]), { limit: 500, offset: 0 })).map(
        (item) => item.id,
      ),
    );
    expect(all.filter((id) => f.seeded.some((s) => s.id === id))).toEqual(own);
    expect(all).toHaveLength(3 + own.length);
    const pageSize = 2;
    const pages: string[][] = [];
    for (let offset = 0; offset < all.length; offset += pageSize) {
      pages.push(
        await f.tx(async (t) =>
          (await port().listTargetTypes(t, f.w.tenant.id, f.predicate([f.w.orgId]), { limit: pageSize, offset })).map(
            (item) => item.id,
          ),
        ),
      );
    }
    expect(pages.flat()).toEqual(all);
    expect(pages.every((p, index) => p.length === pageSize || index === pages.length - 1)).toBe(true);
    expect(await page(2, 100)).toEqual([]);
    // 范围换成其他组织：只看到其他组织的类型
    const other = await f.tx(async (t) =>
      (await port().listTargetTypes(t, f.w.tenant.id, f.predicate([f.otherOrg]), { limit: 500, offset: 0 })).map(
        (item) => item.id,
      ),
    );
    expect(other.sort()).toEqual(
      f.seeded
        .filter((item) => item.org === 'other')
        .map((item) => item.id)
        .sort(),
    );
  });

  it('传 sql`true` 不按任职资格范围过滤；空范围（没有任何组织）什么都看不到；谓词不是 SQL 时抛错（fail-closed）', async () => {
    const f = await typeWorld('ql-list-all');
    const total = f.seeded.length + 3;
    const everything = await f.tx((t) =>
      port().listTargetTypes(t, f.w.tenant.id, sql`true`, { limit: 500, offset: 0 }),
    );
    expect(everything).toHaveLength(total);
    const nothing = await f.tx((t) =>
      port().listTargetTypes(t, f.w.tenant.id, f.predicate([]), { limit: 500, offset: 0 }),
    );
    expect(nothing).toEqual([]);
    for (const bad of [undefined, null, {}, 'true', true]) {
      await expect(
        f.tx((t) => port().listTargetTypes(t, f.w.tenant.id, bad, { limit: 10, offset: 0 })),
      ).rejects.toThrow();
    }
  });

  it('listTargetTypes 返回 id / name / parentId，停用的不列；listTargets 可按类型过滤，只列启用的指标', async () => {
    const f = await portWorld('ql-list-shape');
    const types = await f.tx((t) => port().listTargetTypes(t, f.w.tenant.id, sql`true`, { limit: 500, offset: 0 }));
    expect(types).toEqual([
      { id: f.rootType.id, name: '专业能力', parentId: null },
      { id: f.childType.id, name: '编程', parentId: f.rootType.id },
      { id: f.otherType.id, name: '通用素质', parentId: null },
    ]);
    const all = await f.tx((t) => port().listTargets(t, f.w.tenant.id, sql`true`, { limit: 500, offset: 0 }));
    expect(all.map((item) => item.code)).toEqual(['Z1', 'Z2', 'Z3']);
    expect(all[0]).toEqual({ id: f.plain.id, code: 'Z1', name: '代码质量', typeId: f.childType.id });
    const byType = await f.tx((t) =>
      port().listTargets(t, f.w.tenant.id, sql`true`, { limit: 500, offset: 0, typeId: f.rootType.id }),
    );
    expect(byType.map((item) => item.code)).toEqual(['Z2']);

    await f.w.request('PATCH', `/targets/${f.plain.id}`, { ifMatch: f.plain.revision, body: { enabled: false } });
    const enabled = await f.tx((t) => port().listTargets(t, f.w.tenant.id, sql`true`, { limit: 500, offset: 0 }));
    expect(enabled.map((item) => item.code)).toEqual(['Z2', 'Z3']);
  });

  it('有界：单次最多 500，limit 必须是 1～500 的整数，offset 非负整数', async () => {
    const f = await portWorld('ql-list-bound');
    for (const page of [
      { limit: 501, offset: 0 },
      { limit: 0, offset: 0 },
      { limit: 1.5, offset: 0 },
      { limit: 10, offset: -1 },
    ]) {
      await expect(f.tx((t) => port().listTargetTypes(t, f.w.tenant.id, sql`true`, page))).rejects.toThrow(RangeError);
      await expect(f.tx((t) => port().listTargets(t, f.w.tenant.id, sql`true`, page))).rejects.toThrow(RangeError);
    }
  });

  it('指标是只放开查看的对象（DEC-352）：qualificationReadableSql 对 target 恒真，不按管理单元裁剪', async () => {
    const f = await portWorld('ql-readable');
    const ctx = { tenantId: f.w.tenant.id, now: QL_NOW, timezone: 'Asia/Shanghai' };
    const empty = { orgIds: [], personIds: [], all: false, hasDataPermission: false, terms: [] };
    const evaluate = (predicate: unknown) =>
      f.tx(async (t) => {
        const result = await t.execute(sql`SELECT (${predicate}) AS ok FROM (SELECT 1) t`);
        return (Array.isArray(result) ? result : (result as { rows: { ok: boolean }[] }).rows)[0]!.ok;
      });
    expect(await evaluate(qualificationReadableSql(ctx, empty, 'target'))).toBe(true);
    expect(await evaluate(sql`true`)).toBe(true);
  });
});

describe('AC-QL-indicator-port 第 1 轮 P2-1：两类筛选都在 500 上限检查之前生效（超限仍报错，不静默截断）', () => {
  /** 一个有 501 个指标的级别列：类型 A 500 个、类型 B 1 个（SQL 夹具，避免 501 次接口调用）。 */
  async function bigColumn(label: string) {
    const f = await portWorld(label);
    const category = await f.w.category(f.klass.id);
    await f.w.standard({ categoryId: category.id, levelIds: [f.p1.id], details: [] });
    const tenant = f.w.tenant.id;
    const owner = f.w.user.id;
    const insertTargets = (prefix: string, typeId: string, count: number) =>
      f.tx((t) =>
        t.execute(sql`INSERT INTO ql_targets
          (id, tenant_id, code, name, type_id, eval_mode, owner_id, owner_org_id, created_by)
          SELECT gen_random_uuid(), ${tenant}::uuid, ${prefix} || g, ${prefix} || g, ${typeId}::uuid, 'score',
            ${owner}::uuid, ${f.w.orgId}::uuid, ${owner}::uuid FROM generate_series(1, ${count}::int) g`),
      );
    await insertTargets('BA', f.rootType.id, 500);
    await insertTargets('BB', f.otherType.id, 1);
    await f.tx((t) =>
      t.execute(sql`INSERT INTO ql_standard_details (tenant_id, standard_id, level_id, target_id)
        SELECT ${tenant}::uuid, s.id, ${f.p1.id}::uuid, g.id
        FROM ql_standards s, ql_targets g
        WHERE s.tenant_id = ${tenant}::uuid AND s.category_id = ${category.id}::uuid
          AND g.tenant_id = ${tenant}::uuid AND g.code ~ '^B[AB][0-9]+$'`),
    );
    const id = await f.employee();
    await f.record(id, { categoryId: category.id });
    const run = (filter?: { targetTypeIds?: string[]; targetIds?: string[] }) =>
      f.tx((t) => port().indicators(t, tenant, id, '2026-06-01', filter));
    const idOf = async (code: string) =>
      f.tx(async (t) => {
        const result = await t.execute(
          sql`SELECT id FROM ql_targets WHERE tenant_id = ${tenant}::uuid AND code = ${code}`,
        );
        return (Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows)[0]!.id;
      });
    return { ...f, run, idOf };
  }

  it('同级别 501 个指标：筛选后不超 500 的合法小结果集照常返回（含小类型、空数组、不匹配类型、交集）', async () => {
    const f = await bigColumn('qi-bound-filter');
    const codes = async (filter: { targetTypeIds?: string[]; targetIds?: string[] }) => {
      const outcome = await f.run(filter);
      return outcome.ok ? outcome.data.map((item) => item.code) : outcome;
    };
    expect(await codes({ targetTypeIds: [f.otherType.id] })).toEqual(['BB1']);
    expect(await codes({ targetTypeIds: [] })).toEqual([]);
    expect(await codes({ targetIds: [] })).toEqual([]);
    expect(await codes({ targetTypeIds: [randomUUID()] })).toEqual([]);
    const a1 = await f.idOf('BA1');
    expect(await codes({ targetTypeIds: [f.rootType.id], targetIds: [a1] })).toEqual(['BA1']);
    expect(await codes({ targetTypeIds: [f.otherType.id], targetIds: [a1] })).toEqual([]);
    const outcome = await f.run({ targetTypeIds: [f.rootType.id] });
    expect(outcome.ok && outcome.data).toHaveLength(500);
  });

  it('筛选后仍超 500（或不筛选）→ 显式 RangeError，不静默截断', async () => {
    const f = await bigColumn('qi-bound-over');
    await expect(f.run()).rejects.toThrow(RangeError);
    await expect(f.run({ targetTypeIds: [f.rootType.id, f.otherType.id] })).rejects.toThrow(RangeError);
  });
});

describe('AC-QL-indicator-port 第 1 轮 P3-1：指标类型树不静默截断', () => {
  async function chainWorld(label: string, depth: number) {
    const f = await portWorld(label);
    const tenant = f.w.tenant.id;
    const owner = f.w.user.id;
    const ids: string[] = [];
    const names: string[] = [];
    for (let level = 0; level < depth; level++) {
      const id = randomUUID();
      ids.push(id);
      names.push(`层${level}`);
      await f.tx((t) =>
        t.execute(sql`INSERT INTO ql_target_types
          (id, tenant_id, code, name, parent_id, display_order, enabled, owner_id, owner_org_id, created_by)
          VALUES (${id}::uuid, ${tenant}::uuid, ${`DP${level}`}, ${names[level]}, ${ids[level - 1] ?? null}::uuid, ${level},
            true, ${owner}::uuid, ${f.w.orgId}::uuid, ${owner}::uuid)`),
      );
    }
    const deepTarget = await f.w.target(ids[depth - 1]!, { code: 'ZDEEP', name: '深层指标' });
    const category = await f.w.category(f.klass.id);
    await f.w.standard({
      categoryId: category.id,
      levelIds: [f.p1.id],
      details: [{ levelId: f.p1.id, targetId: deepTarget.id }],
    });
    const employee = await f.employee();
    await f.record(employee, { categoryId: category.id });
    const run = (filter?: { targetTypeIds?: string[] }) =>
      f.tx((t) => port().indicators(t, tenant, employee, '2026-06-01', filter));
    return { ...f, ids, names, run };
  }

  it('22 层类型树：路径含全部 22 层，按根类型筛选能找到最深的指标', async () => {
    const f = await chainWorld('qi-depth-22', 22);
    const outcome = await f.run({ targetTypeIds: [f.ids[0]!] });
    expect(outcome.ok && outcome.data.map((item) => item.code)).toEqual(['ZDEEP']);
    expect(outcome.ok && outcome.data[0]!.targetTypePath).toEqual(f.names);
  });

  it('类型树深度超过上限（100 层）→ 显式 RangeError，不返回缺层的路径', async () => {
    const f = await chainWorld('qi-depth-101', 101);
    await expect(f.run()).rejects.toThrow(RangeError);
  });
});

describe('AC-QL-indicator-port 第 1 轮 P3-2：失败结果同样冻结', () => {
  it('三种失败原因的返回对象都是冻结的', async () => {
    const f = await portWorld('qi-frozen-fail');
    const none = await f.employee();
    const noStandard = await f.employee();
    await f.record(noStandard, { categoryId: f.otherCategory.id });
    const outOfRange = await f.employee();
    await f.record(outOfRange, { levelId: f.p3.id });
    for (const id of [none, noStandard, outOfRange]) {
      const outcome = await f.tx((t) => port().indicators(t, f.w.tenant.id, id, '2026-06-01'));
      expect(outcome.ok).toBe(false);
      expect(Object.isFrozen(outcome)).toBe(true);
    }
  });
});
