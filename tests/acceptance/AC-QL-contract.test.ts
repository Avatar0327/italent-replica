/**
 * R3-T02 PR-0 契约（设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §1.1、§1.3、§5.1、§6.2；DEC-324②）：
 * - owner-units 抽到 permission/owner-units.ts 并按应用取授权管理单元（用户 × 应用一份范围，DEC-043）：
 *   任职资格与人才标准的授权管理单元互不串用；无 / 一个 / 多个 / 选了别人的单元，行为与 #106 相同；
 * - publicDownSql / readableSql 抽到 permission/public-down.ts，保留 IDP 的语义：范围内组织为空恒为 false、
 *   起点含本组织、沿行政维度向上；看全部时 readableSql 为 true；
 * - Qualification / TEvaluation 两个应用的对象目录：资源集合（所属管理单元）只在原站有 StdSetID 的对象上，由系统填写
 *   （系统字段，Q-M0-132）；“向下公开”是复刻系统的扩展（DEC-324②），只在这些对象上、可编辑；评价表 / 评审组 /
 *   评定活动的“所属组织”是手选的业务字段，没有向下公开；
 * - 两个应用的配置对象都登记了审计对象名与查看规则；
 * - QualificationIndicatorPort 未登记时为 null，登记后取到同一实现（§6.2 (1)）。
 */
import { sql, withTenant } from '@italent/db';
import { auditObjectMeta, type ObjectDefinition, type QualificationIndicator } from '@italent/domain';
import * as domain from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { auditObjectRegistered } from '../../apps/api/src/audit/visibility.js';
import { scopeAppOf } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { createMou, createOrg, talentWorld, TC_NOW, TC_PERMISSION_PATH } from './AC-TC-support.js';
import type * as OwnerUnits from '../../apps/api/src/modules/permission/owner-units.js';
import type * as PublicDown from '../../apps/api/src/modules/permission/public-down.js';

const testDb = useTestDb();

// 动态路径：实现落地前用例因模块缺失而失败，而不是整个文件无法加载。
const load = async <T>(path: string) => (await import(path)) as T;
const ownerUnits = () => load<typeof OwnerUnits>('../../apps/api/src/modules/permission/owner-units.js');
const publicDown = () => load<typeof PublicDown>('../../apps/api/src/modules/permission/public-down.js');

const QL_APP = 'Qualification';
const EV_APP = 'TEvaluation';
const ASOF = '2026-10-07';

type Catalog = Readonly<Record<string, ObjectDefinition>>;
const catalogOf = (name: string): Catalog => {
  const value = (domain as Record<string, unknown>)[name];
  expect(value, name).toBeTruthy();
  return value as Catalog;
};
const fieldOf = (definition: ObjectDefinition, code: string) => definition.fields.find((field) => field.code === code);

async function world(label: string) {
  const w = await talentWorld(testDb().db, label);
  /** 用户 × 应用的授权管理单元（经数据范围接口，与 #106 同一入口）。 */
  const revisions = new Map<string, number>();
  const assign = async (appCode: string, orgIds: readonly string[] | null) => {
    const mouId = orgIds ? await createMou(w.api, w.as, orgIds, appCode) : null;
    const response = await w.api.request('PUT', `${TC_PERMISSION_PATH}/scopes/${w.as.user}/${appCode}`, {
      ...w.as,
      ifMatch: revisions.get(appCode) ?? 0,
      body: mouId ? { kind: 'mou', mouId } : { kind: 'default' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revisions.set(appCode, ((await response.json()) as { revision: number }).revision);
  };
  const tx = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(testDb().db, w.tenant.id, work);
  const unitCtx = { tenantId: w.tenant.id, userId: w.as.user, now: TC_NOW, timezone: 'Asia/Shanghai' };
  return { w, assign, tx, unitCtx };
}

describe('PR-0 ①：授权管理单元按应用取（permission/owner-units.ts）', () => {
  it('任职资格与人才标准各自一份范围：互不串用，缺省为空', async () => {
    const { w, assign, tx } = await world('ql-units-app');
    const { authorizedUnits } = await ownerUnits();
    const qlOrg = await createOrg(w.api, w.as, 'ql-units-app任职资格部');
    const units = (appCode: string) => tx((t) => authorizedUnits(t, w.tenant.id, w.as.user, appCode, ASOF));

    expect((await units('TalentCenter')).map((u) => u.id)).toEqual([w.orgId]);
    expect(await units(QL_APP)).toEqual([]);

    await assign(QL_APP, [qlOrg]);
    expect((await units(QL_APP)).map((u) => u.id)).toEqual([qlOrg]);
    expect((await units('TalentCenter')).map((u) => u.id)).toEqual([w.orgId]);
    expect(await units(EV_APP)).toEqual([]);
    // nameable 缺省 false：只决定 named，不影响候选本身
    expect((await units(QL_APP))[0]).toMatchObject({ id: qlOrg, named: false });
  });

  it('chooseUnit：无 → 403 NO_MANAGEMENT_UNIT；一个自动；选了别人的单元 404；多个不选 400', async () => {
    const { w, assign, tx, unitCtx } = await world('ql-units-choose');
    const { chooseUnit } = await ownerUnits();
    const choose = (requested?: string) => tx((t) => chooseUnit(t, unitCtx, QL_APP, requested));

    await expect(choose()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: '无可用的管理单元，请联系管理员授权',
      details: { reason: 'NO_MANAGEMENT_UNIT' },
    });

    const a = await createOrg(w.api, w.as, 'ql-units-choose甲');
    await assign(QL_APP, [a]);
    expect(await choose()).toBe(a);
    expect(await choose(a)).toBe(a);
    // 人才标准的单元不属于本人在任职资格应用的授权管理单元；与不存在的组织同一个 404
    await expect(choose(w.orgId)).rejects.toMatchObject({ code: 'NOT_FOUND', message: '所属管理单元不存在' });
    await expect(choose('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: '所属管理单元不存在',
    });

    const b = await createOrg(w.api, w.as, 'ql-units-choose乙');
    await assign(QL_APP, [a, b]);
    await expect(choose()).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'MANAGEMENT_UNIT_REQUIRED' },
    });
    expect(await choose(b)).toBe(b);
  });
});

describe('PR-0 ②：向下公开谓词（permission/public-down.ts，保留 IDP 语义）', () => {
  it('范围内组织为空恒 false；起点含本组织；沿行政维度向上；兄弟组织不算', async () => {
    const { w, tx } = await world('ql-public-down');
    const { publicDownSql, readableSql } = await publicDown();
    const child = await createOrg(w.api, w.as, 'ql-public-down下级', w.orgId);
    const sibling = await createOrg(w.api, w.as, 'ql-public-down兄弟');
    const ctx = { tenantId: w.tenant.id, now: TC_NOW, timezone: 'Asia/Shanghai' };
    const scoped: ModuleScope = { ...EMPTY_SCOPE, orgIds: [child], hasDataPermission: true, terms: undefined };
    const holds = (scope: ModuleScope, org: string) =>
      tx(async (t) => {
        // 与 IDP 原实现相同：组织链顶端的上级为 NULL 时 IN 结果为 NULL，调用方按“不是 true 即不可见”处理
        const predicate = publicDownSql(ctx, scope, sql`${org}::uuid`);
        const result = await t.execute(sql`SELECT COALESCE(${predicate}, false) AS v`);
        const rows = (Array.isArray(result) ? result : (result as { rows: { v: boolean }[] }).rows) as { v: boolean }[];
        return rows[0]!.v;
      });

    expect(await holds(EMPTY_SCOPE, w.orgId)).toBe(false);
    expect(await holds(scoped, w.orgId)).toBe(true);
    expect(await holds(scoped, child)).toBe(true);
    expect(await holds(scoped, sibling)).toBe(false);
    // 只认管理 / 组织维度的范围：汇报关系等其他维度的条目不展开组织
    const personOnly: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'reporting', orgIds: [child], personIds: [] }],
    };
    expect(await holds(personOnly, w.orgId)).toBe(false);

    const all = readableSql(ctx, { ...EMPTY_SCOPE, all: true }, { org: sql`o`, publicDown: sql`p`, creator: sql`c` });
    const rendered = await tx(async (t) => {
      const result = await t.execute(sql`SELECT ${all} AS v`);
      return ((Array.isArray(result) ? result : (result as { rows: { v: boolean }[] }).rows) as { v: boolean }[])[0];
    });
    expect(rendered?.v).toBe(true);
  });
});

describe('PR-0 ③：Qualification / TEvaluation 对象目录（Q-M0-132、DEC-324②）', () => {
  const OWNED = [
    'Qualification.EmploymentCategoryClassify',
    'Qualification.EmploymentCategory',
    'Qualification.EmploymentLevel',
    'Qualification.TargetType',
    'Qualification.Target',
  ];

  it('应用常量与目录登记：对象的数据范围按所属应用解析', () => {
    expect((domain as Record<string, unknown>).QUALIFICATION_APP).toBe(QL_APP);
    expect((domain as Record<string, unknown>).EVALUATION_APP).toBe(EV_APP);
    for (const definition of Object.values(catalogOf('QUALIFICATION_OBJECTS'))) {
      expect(definition.application, definition.code).toBe(QL_APP);
      expect(definition.code.startsWith(`${QL_APP}.`), definition.code).toBe(true);
      expect(scopeAppOf(definition.code), definition.code).toBe(QL_APP);
    }
    for (const definition of Object.values(catalogOf('EVALUATION_OBJECTS'))) {
      expect(definition.application, definition.code).toBe(EV_APP);
      expect(scopeAppOf(definition.code), definition.code).toBe(EV_APP);
    }
  });

  it('资源集合由系统填写（系统字段），向下公开是可编辑的扩展字段；层级、等级方案、编码规则没有', () => {
    const objects = Object.values(catalogOf('QUALIFICATION_OBJECTS'));
    const byCode = new Map(objects.map((definition) => [definition.code, definition]));
    for (const code of OWNED) {
      const definition = byCode.get(code);
      expect(definition, code).toBeTruthy();
      expect(fieldOf(definition!, 'ownerOrgId'), code).toMatchObject({ system: true });
      expect(fieldOf(definition!, 'ownerId'), code).toMatchObject({ system: true });
      expect(fieldOf(definition!, 'publicDown'), code).toMatchObject({ system: false });
    }
    // 标准：资源集合随所属类别（系统字段），可见性锚在类别上，自身不另设向下公开（设计 §5.1）
    const standard = byCode.get('Qualification.QualificationStandard')!;
    expect(fieldOf(standard, 'ownerOrgId')).toMatchObject({ system: true });
    expect(fieldOf(standard, 'publicDown')).toBeUndefined();
    for (const code of ['Qualification.Level', 'Qualification.GradeScheme', 'Qualification.CodingRule']) {
      const definition = byCode.get(code);
      expect(definition, code).toBeTruthy();
      expect(fieldOf(definition!, 'ownerOrgId'), code).toBeUndefined();
      expect(fieldOf(definition!, 'publicDown'), code).toBeUndefined();
    }
  });

  it('评价表 / 评审组 / 评定活动的所属组织是手选的业务字段，没有向下公开；字典类对象没有组织字段', () => {
    const byCode = new Map(Object.values(catalogOf('EVALUATION_OBJECTS')).map((d) => [d.code, d]));
    for (const code of ['TEvaluation.EvaluationForm', 'TEvaluation.ReviewGroup', 'TEvaluation.EvaluationActivity']) {
      const definition = byCode.get(code);
      expect(definition, code).toBeTruthy();
      expect(fieldOf(definition!, 'ownerOrgId'), code).toMatchObject({ system: false });
      expect(fieldOf(definition!, 'ownerId'), code).toMatchObject({ system: true });
      expect(fieldOf(definition!, 'publicDown'), code).toBeUndefined();
    }
    for (const code of ['TEvaluation.ActivityType', 'TEvaluation.ActivityCycle', 'TEvaluation.GeneralScoreItem']) {
      const definition = byCode.get(code);
      expect(definition, code).toBeTruthy();
      expect(fieldOf(definition!, 'ownerOrgId'), code).toBeUndefined();
    }
  });

  it('审计：两个应用的配置对象都登记了对象名与查看规则', () => {
    for (const [name, app] of [
      ['QUALIFICATION_OBJECTS', '任职资格'],
      ['EVALUATION_OBJECTS', '人才评定'],
    ] as const) {
      for (const definition of Object.values(catalogOf(name))) {
        expect(auditObjectRegistered(definition.code), definition.code).toBe(true);
        expect(auditObjectMeta(definition.code).app, definition.code).toBe(app);
        expect(auditObjectMeta(definition.code).label, definition.code).not.toBe(definition.code);
      }
    }
  });
});

describe('PR-0 ④：QualificationIndicatorPort 登记（设计 §6.2 (1)）', () => {
  // C1-3b（DEC-374④ 🟡）：targetTypePath 是“从根到本级的 ID 路径并附名称”，每一级 { id, name }，两者都返回。
  // 编译期：下面的字面量必须满足端口类型（形状变了这里先编译失败）；运行期：形状由 AC-QL-indicator-port 对真实输出断言。
  it('指标的 targetTypePath 形状：每一级 { id, name }（编译期契约）', () => {
    const sample: QualificationIndicator = {
      targetId: 't',
      code: 'c',
      name: 'n',
      targetTypeId: 'leaf',
      targetTypePath: [
        { id: 'root', name: '专业能力' },
        { id: 'leaf', name: '编程' },
      ],
      evalMode: 'score',
      gradeSchemeId: null,
      weight: null,
      targetValue: null,
      abilities: [],
      enabled: true,
    };
    expect(sample.targetTypePath.map((step) => Object.keys(step).sort())).toEqual([
      ['id', 'name'],
      ['id', 'name'],
    ]);
    expect(sample.targetTypePath.at(-1)?.id).toBe(sample.targetTypeId);
  });

  // 第 1 轮 P3-3：隔离模块状态，保住 P0 的登记契约（未装配为 null → 装配后可取 → 还原后为 null）
  it('隔离的模块图里：未装配时为 null，装配后取到同一实现，换一份新模块图后又是 null', async () => {
    vi.resetModules();
    try {
      const fresh = await import('@italent/domain');
      expect(fresh.qualificationIndicatorPort()).toBeNull();
      const { installQualificationIndicatorPort } =
        await import('../../apps/api/src/modules/qualification/indicator-port.js');
      installQualificationIndicatorPort();
      const installed = fresh.qualificationIndicatorPort();
      expect(installed).not.toBeNull();
      expect(typeof installed!.indicators).toBe('function');
      vi.resetModules();
      expect((await import('@italent/domain')).qualificationIndicatorPort()).toBeNull();
    } finally {
      vi.resetModules();
    }
  });

  // C1-3 起装配路由（createApp）即登记真实实现，本文件前面的用例已建过应用，所以不再断言“未登记为 null”（未登记 →
  // 调用方报 INDICATOR_SOURCE_UNAVAILABLE 是 R3-T04 的约定，端口默认值仍是 null）；这里验登记函数的往返并还原。
  it('登记后取到同一实现，之后还原', () => {
    const registry = domain as unknown as {
      qualificationIndicatorPort?: () => unknown;
      registerQualificationIndicatorPort?: (port: unknown) => void;
    };
    expect(typeof registry.qualificationIndicatorPort).toBe('function');
    const installed = registry.qualificationIndicatorPort!();
    const port = {
      indicators: async () => ({ ok: false }),
      listTargetTypes: async () => [],
      listTargets: async () => [],
    };
    registry.registerQualificationIndicatorPort!(port);
    expect(registry.qualificationIndicatorPort!()).toBe(port);
    if (installed) registry.registerQualificationIndicatorPort!(installed);
  });
});
