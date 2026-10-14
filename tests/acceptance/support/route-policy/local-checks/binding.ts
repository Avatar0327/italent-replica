import { expect } from 'vitest';
import { registrationGate, registration } from '../registration.js';
import { checkRequired } from '../required.js';
import { disclosureWeakeningsOf } from '../weakenings.js';
import { type ManifestRoute } from '@italent/api';
import { type RequiredTable } from '../required/types.js';
import { DETECTOR_REQUIRED, DETECTOR_CONTRACT, DETECTOR_SEMANTICS } from '../detector-fixtures.js';
import { INNER_CONDITIONS } from '../required/guard-inner.js';
import type { LocalCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function bindingChecks(context: LocalCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };
  const frozen = context.contract;

  const check = (routes: readonly ManifestRoute[], table: RequiredTable = DETECTOR_REQUIRED) =>
    checkRequired(table, DETECTOR_CONTRACT, routes, DETECTOR_SEMANTICS);
  return [
    {
      id: 'byObject',
      label: 'byObject 有 * 兜底时静态对象取兜底项；真实 byObject 声明（职务 :kind 等）仍零发现',
      wrapped: false,
      verify: () => {
        const jobRoutes = manifest.declared.filter((r) => JSON.stringify(r.policy).includes('"byObject"'));
        expect(jobRoutes.length).toBeGreaterThan(0);
        expect(
          registrationGate(checkRequired(REQUIRED, frozen, jobRoutes), '真实 byObject 声明 × 静态义务登记（DEC-416③）'),
        ).toEqual([]);
      },
    },
    {
      id: 'foreignScope',
      label: '生成弱化 scope→foreign-object（范围只登记给无关对象）：对每个“唯一满足 need 的来源节点”施加，全部报出',
      wrapped: false,
      verify: () => {
        const all = manifest.declared.flatMap((r) => disclosureWeakeningsOf(r, REQUIRED));
        const foreign = all.filter((w) => w.kind === 'scope→foreign-object');
        registration('真实表的范围弱化端点统计', () =>
          expect(new Set(foreign.map((w) => `${w.route.method} ${w.route.path}`)).size).toBeGreaterThanOrEqual(42),
        );
        registration('真实表的范围弱化数量', () => expect(foreign.length).toBeGreaterThanOrEqual(49));
        const missed = foreign.filter((w) => !check([w.route], REQUIRED).some((f) => f.code === w.expected));
        expect(
          missed.map((w) => `${w.route.method} ${w.route.path} @${w.at}`),
          '未报出',
        ).toEqual([]);
      },
    },
    {
      id: 'whenConditions',
      label: '八组守卫内部 when 条件',
      wrapped: false,
      verify: () => {
        for (const args of BINDING_CONDITIONS) bindingConditionCheck(REQUIRED, args[0], args[1], args[2], args[3]);
      },
    },
    {
      id: 'conditionSemantics',
      label: '每个 when 条件都登记了语义（含空数组 / 已有引用 / 新增引用的说明）；表里用到的条件都已登记',
      wrapped: false,
      verify: () => {
        const used = new Set(
          Object.values(REQUIRED)
            .flat()
            .flatMap((o) => (o.inner?.role === 'when' ? [o.inner.condition] : [])),
        );
        registration('真实表用到的内部条件登记', () =>
          expect([...used].filter((name) => !INNER_CONDITIONS[name])).toEqual([]),
        );
        for (const name of ['channels.nonEmpty', 'grade.changed', 'dimensions.nonEmpty', 'dimensions.newReference']) {
          registration(`${name} 条件语义`, () => expect(INNER_CONDITIONS[name], name).toMatch(/空数组|已有|新增|变更/));
        }
        registration('details.targetReference 条件语义', () =>
          expect(INNER_CONDITIONS['details.targetReference']).toContain('空数组'),
        );
        registration('dimensions.newReference 条件语义', () =>
          expect(INNER_CONDITIONS['dimensions.newReference']).toContain('weight'),
        );
      },
    },
    {
      id: 'orCounts',
      label: '现表的内部“或”义务：审批 canOpen 管理员按钮 6 条 + IDP 执行人计划查看权 9 条，全部登记',
      wrapped: false,
      verify: () => {
        const actual = Object.values(REQUIRED)
          .flat()
          .filter((o) => o.inner?.role === 'or');
        registration('审批 canOpen 内部或数量', () =>
          expect(actual.filter((o) => o.purpose === 'guard:approval.canOpen')).toHaveLength(6),
        );
        registration('IDP 执行人内部或数量', () =>
          expect(actual.filter((o) => o.purpose === 'guard:idp.executor')).toHaveLength(9),
        );
      },
    },
  ];
}

export const BINDING_CONDITIONS = [
  [
    `PUT /api/tenant/qualification/standards/:id/channels`,
    'obj:Qualification.EmploymentCategory:view',
    'ql.referenced(category)',
    'channels.nonEmpty',
  ],
  [
    `PUT /api/tenant/qualification/standards/:id/channels`,
    'obj:Qualification.EmploymentLevel:view',
    'ql.referenced(level)',
    'channels.nonEmpty',
  ],
  [
    `PATCH /api/tenant/qualification/targets/:id`,
    'obj:Qualification.GradeScheme:view',
    'ql.referenced(gradeScheme)',
    'grade.changed',
  ],
  [
    `POST /api/tenant/qualification/targets`,
    'obj:Qualification.GradeScheme:view',
    'ql.referenced(gradeScheme)',
    'evalMode=grade',
  ],
  [
    `POST /api/tenant/talent/criteria`,
    'obj:TalentCenter.Dimension:view',
    'talent.referenced(dimension)',
    'dimensions.nonEmpty',
  ],
  [
    `PATCH /api/tenant/talent/criteria/:id`,
    'obj:TalentCenter.Dimension:view',
    'talent.referenced(dimension)',
    'dimensions.newReference',
  ],
  [
    `POST /api/tenant/qualification/standards`,
    'obj:Qualification.Target:view',
    'ql.referenced(target)',
    'details.targetReference',
  ],
  [
    `PATCH /api/tenant/qualification/standards/:id`,
    'obj:Qualification.Target:view',
    'ql.referenced(target)',
    'details.targetReference',
  ],
] as const;

export function bindingConditionCheck(
  table: RequiredTable,
  key: string,
  perm: string,
  carrier: string,
  expected: string,
) {
  const inner = (table[key] ?? []).find((o) => o.perm === perm && o.purpose === `guard:${carrier}`)?.inner;
  const condition = inner?.role === 'when' ? inner.condition : undefined;
  registration(`${key} ${perm} 内部条件登记`, () => expect(condition).toBe(expected));
}
