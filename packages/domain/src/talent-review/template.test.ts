import { describe, expect, it } from 'vitest';
import { checkByCount, checkModules, checkPermissions, weightConfigErrors, type ModuleInput } from './template.js';

const indicator = (extra: Partial<ModuleInput> = {}): ModuleInput => ({
  kind: 'indicator',
  name: '业绩',
  source: 'qualification',
  scoring: 'weighted_sum',
  scoreRuleId: 'r1',
  ...extra,
});

describe('盘点模板 · 模块规则（TR-R13～R15）', () => {
  it('名称版本内唯一；指标评估须有来源 / 算分方式 / 评价规则；其它类型不能带评分配置', () => {
    expect(checkModules([indicator(), { kind: 'info', name: '信息', fieldIds: ['f1'] }])).toBeNull();
    expect(checkModules([indicator(), indicator()])?.reason).toBe('MODULE_NAME_DUPLICATE');
    expect(checkModules([indicator({ source: null })])?.reason).toBe('MODULE_SOURCE_REQUIRED');
    expect(checkModules([indicator({ scoreRuleId: null })])?.reason).toBe('MODULE_SCORING_REQUIRED');
    expect(checkModules([{ kind: 'info', name: '信息', scoring: 'by_count' }])?.reason).toBe('MODULE_KIND_MISMATCH');
    expect(checkModules([{ kind: 'succession', name: '继任', fieldIds: ['f1'] }])?.reason).toBe('MODULE_KIND_MISMATCH');
    expect(checkModules([{ kind: 'info', name: '信息', fieldIds: ['f1', 'f1'] }])?.reason).toBe(
      'MODULE_FIELD_DUPLICATE',
    );
  });

  it('人才标准来源：指定须选标准、按主职职务不指定、维度限能力 / 潜力 / 经历；任职资格不带人才标准设置', () => {
    const talent = (extra: Partial<ModuleInput>) => indicator({ source: 'talent_standard', ...extra });
    expect(
      checkModules([talent({ criterionMode: 'designated', criterionId: 'c1', dimensionTypes: ['ability'] })]),
    ).toBeNull();
    expect(checkModules([talent({})])?.reason).toBe('MODULE_CRITERION_MODE_REQUIRED');
    expect(checkModules([talent({ criterionMode: 'designated' })])?.reason).toBe('MODULE_CRITERION_REQUIRED');
    expect(checkModules([talent({ criterionMode: 'by_job', criterionId: 'c1' })])?.reason).toBe(
      'MODULE_CRITERION_NOT_ALLOWED',
    );
    expect(checkModules([talent({ criterionMode: 'by_job', dimensionTypes: ['skill'] })])?.reason).toBe(
      'MODULE_DIMENSION_INVALID',
    );
    expect(checkModules([indicator({ criterionMode: 'by_job' })])?.reason).toBe('MODULE_CRITERION_NOT_ALLOWED');
  });

  it('按指标数目算分：评价规则只能是等级类，且须选按指标数目的模块等级', () => {
    expect(checkByCount({ kind: 'grade' }, { mode: 'count' })).toBeNull();
    expect(checkByCount({ kind: 'numeric' }, { mode: 'count' })?.reason).toBe('MODULE_BY_COUNT_RULE');
    expect(checkByCount({ kind: 'grade' }, { mode: 'score' })?.reason).toBe('MODULE_BY_COUNT_GRADE');
    expect(checkByCount({ kind: 'grade' }, null)?.reason).toBe('MODULE_BY_COUNT_GRADE');
  });
});

describe('盘点模板 · 步骤权限（TR-R16、R18）', () => {
  const steps = [
    { nodeKey: 'self', kind: 'single' as const, roleIds: ['r-self'] },
    { nodeKey: 'peers', kind: 'countersign' as const, roleIds: ['r1', 'r2'] },
  ];
  const modules = [
    { kind: 'indicator' as const, name: '业绩' },
    { kind: 'succession' as const, name: '继任' },
    { kind: 'info' as const, name: '信息' },
  ];

  it('会签步骤的行须指向步骤角色，单人步骤不带角色；同一席位 × 模块一行；引用须存在', () => {
    expect(checkPermissions(steps, modules, [{ nodeKey: 'self', moduleName: '业绩' }])).toBeNull();
    expect(checkPermissions(steps, modules, [{ nodeKey: 'peers', roleId: 'r1', moduleName: '业绩' }])).toBeNull();
    const reason = (rows: Parameters<typeof checkPermissions>[2]) => checkPermissions(steps, modules, rows)?.reason;
    expect(reason([{ nodeKey: 'peers', moduleName: '业绩' }])).toBe('PERMISSION_ROLE_INVALID');
    expect(reason([{ nodeKey: 'peers', roleId: 'rX', moduleName: '业绩' }])).toBe('PERMISSION_ROLE_INVALID');
    expect(reason([{ nodeKey: 'self', roleId: 'r-self', moduleName: '业绩' }])).toBe('PERMISSION_ROLE_INVALID');
    expect(
      reason([
        { nodeKey: 'self', moduleName: '业绩' },
        { nodeKey: 'self', moduleName: '业绩' },
      ]),
    ).toBe('PERMISSION_DUPLICATE');
    expect(reason([{ nodeKey: 'nope', moduleName: '业绩' }])).toBe('PERMISSION_STEP_UNKNOWN');
    expect(reason([{ nodeKey: 'self', moduleName: '无' }])).toBe('PERMISSION_MODULE_UNKNOWN');
    expect(reason([{ nodeKey: 'self', moduleName: '信息' }])).toBe('PERMISSION_INFO_MODULE');
  });

  it('必填以启用为前提、权重只给启用评分的席位、继任档只给继任模块', () => {
    const reason = (row: object) =>
      checkPermissions(steps, modules, [{ nodeKey: 'self', moduleName: '业绩', ...row }])?.reason;
    expect(reason({ scoreRequired: true, scoreEnabled: false })).toBe('PERMISSION_REQUIRED_NEEDS_ENABLED');
    expect(reason({ commentRequired: true, commentEnabled: false })).toBe('PERMISSION_REQUIRED_NEEDS_ENABLED');
    expect(reason({ weight: 50, scoreEnabled: false })).toBe('PERMISSION_WEIGHT_NEEDS_SCORE');
    expect(reason({ successorAccess: 'edit' })).toBe('PERMISSION_KIND_MISMATCH');
    const onSuccession = (row: object) =>
      checkPermissions(steps, modules, [{ nodeKey: 'self', moduleName: '继任', ...row }])?.reason;
    expect(onSuccession({ successorAccess: 'edit', targetAccess: 'hidden' })).toBeUndefined();
    expect(onSuccession({ weight: 10 })).toBe('PERMISSION_KIND_MISMATCH');
  });
});

describe('盘点模板 · 配置错误 WEIGHT_SUM_NOT_100（D-03）', () => {
  const modules = [
    { kind: 'indicator' as const, name: '业绩' },
    { kind: 'indicator' as const, name: '能力' },
    { kind: 'info' as const, name: '信息' },
  ];
  it('各评分席位权重之和 ≠ 100 → 报错（含和）；= 100 不报；未启用评分 / 不可见的席位不计；非指标模块不查', () => {
    const rows = [
      { moduleName: '业绩', visible: true, scoreEnabled: true, weight: 60 },
      { moduleName: '业绩', visible: true, scoreEnabled: true, weight: 40 },
      { moduleName: '业绩', visible: true, scoreEnabled: false, weight: null },
      { moduleName: '能力', visible: true, scoreEnabled: true, weight: 33.33 },
      { moduleName: '能力', visible: false, scoreEnabled: true, weight: 66.67 },
    ];
    expect(weightConfigErrors(modules, rows)).toEqual([{ moduleName: '能力', code: 'WEIGHT_SUM_NOT_100', sum: 33.33 }]);
  });
  it('没有任何评分席位的指标模块和为 0 → 报错；权重为空按 0 计', () => {
    expect(weightConfigErrors(modules, [])).toEqual([
      { moduleName: '业绩', code: 'WEIGHT_SUM_NOT_100', sum: 0 },
      { moduleName: '能力', code: 'WEIGHT_SUM_NOT_100', sum: 0 },
    ]);
  });
});
