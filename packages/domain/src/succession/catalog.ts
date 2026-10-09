/**
 * 继任管理的权限对象目录（R3-T05 设计 §8.1；DEC-080 真实字段与按钮）。继任属于应用 `SuccessionAndDevelopment`
 * （原站「继任与发展」，`27` 文首配置证据）：对象只能配置进、也只在登记了该应用的身份里生效，数据范围按
 * （用户 × SuccessionAndDevelopment）存一份（DEC-043），缺省为空。R3-T06 人才池同属该应用，对象在自己的目录登记。
 * 契约 PR 一次登记全部对象，标准身份、审计标签与审计查看规则都从这里取，PR-A～PR-D 不再改共享文件（设计 §12、§13）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const SUCCESSION_APP = 'SuccessionAndDevelopment';
/** 审计日志「应用」列（docs/02_业务建模/20 §2；原站菜单名）。 */
export const SUCCESSION_APP_LABEL = '继任与发展';

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];
const crud: readonly ButtonDefinition[] = [
  { code: 'create', level: 'list', requires: 'create' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'detail', requires: 'delete' },
];
const reorder: ButtonDefinition = { code: 'reorder', level: 'list', requires: 'update' };

/** fields = 可授编辑的业务字段；system = 派生 / 可信系统值（DEC-251），只能授查看。 */
function object(
  code: string,
  fields: readonly string[],
  system: readonly string[],
  buttons: readonly ButtonDefinition[],
): ObjectDefinition {
  return {
    code: `Succession.${code}`,
    application: SUCCESSION_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons,
  };
}

/** 风险 / 健康度等级的规则正文（§1.3、§1.4）：条件行 + 表达式整体为 rules，编译结果只读。 */
const levelObject = (code: string) =>
  object(
    code,
    ['code', 'name', 'color', 'description', 'displayOrder', 'rules', 'enabled'],
    ['compileError'],
    [...crud, reorder],
  );

export const SUCCESSION_OBJECTS = {
  /**
   * 继任记录（原站 `SuccessionAndDevelopment.Map`，§1.1）。目标与继任者建后不可改（FIELD_IMMUTABLE 由服务层判定），
   * 状态、现任、负责人按 asOf 派生（D1），来源与结束来源是可信系统值。范围锚点 = 目标组织（职位按所属组织）。
   */
  record: object(
    'Record',
    [
      'successionType',
      'targetOrgId',
      'targetPositionId',
      'successorEmployeeId',
      'readinessId',
      'backupType',
      'startDate',
      'endDate',
      'endReason',
    ],
    ['endSource', 'sourceKind', 'status', 'incumbents', 'personInCharge'],
    [...crud, { code: 'end', level: 'list', requires: 'update' }],
  ),
  /** 继任地图（§5.5、§5.6）：只读视图，三个计算按钮不做数据写入操作（结果对象另授）。 */
  map: object(
    'Map',
    [],
    ['successors', 'successorCount', 'stats', 'keyPositions'],
    [
      { code: 'computeRisk', level: 'list' },
      { code: 'computeHealth', level: 'list' },
      { code: 'computeStats', level: 'list' },
    ],
  ),
  /** 职位风险等级结果（§1.3）：只有 levelId 可手动赋值；method 由入口派生。 */
  riskResult: object(
    'RiskResult',
    ['levelId'],
    ['positionId', 'levelName', 'levelColor', 'method', 'computedAt'],
    [{ code: 'assign', level: 'detail', requires: 'update' }],
  ),
  /** 组织健康度结果（§1.4）：手动赋值与重置（DEC-305④）。 */
  healthResult: object(
    'HealthResult',
    ['levelId'],
    ['orgId', 'levelName', 'levelColor', 'method', 'computedAt', 'sourceProjectId'],
    [
      { code: 'assign', level: 'detail', requires: 'update' },
      { code: 'reset', level: 'list', requires: 'update' },
    ],
  ),
  riskLevel: levelObject('RiskLevel'),
  healthLevel: levelObject('HealthLevel'),
  /** 人员范围（原站 PersonnelScope，§1.4）：没有颜色、描述与启用开关。 */
  population: object('Population', ['code', 'name', 'displayOrder', 'rules'], ['compileError'], [...crud, reorder]),
  /** 风险 / 健康度的默认颜色（§1.3），每租户每类一行。 */
  ruleSettings: object(
    'RuleSettings',
    ['defaultColor'],
    ['kind'],
    [{ code: 'update', level: 'detail', requires: 'update' }],
  ),
  /** 计算任务（§1.5）：只读 + 重试；范围逐对象（§8.4）。 */
  calcRun: object(
    'CalcRun',
    [],
    ['kind', 'trigger', 'status', 'requestedBy', 'startedAt', 'finishedAt', 'visibleCounts', 'failures'],
    [{ code: 'retry', level: 'detail', requires: 'update' }],
  ),
  /** 盘点 → 继任同步批次（§1.2）：只读 + 再驱动 / 重试 / 终止；范围逐目标（§8.4）。 */
  syncBatch: object(
    'SyncBatch',
    [],
    ['projectId', 'meetingId', 'trigger', 'strategy', 'status', 'visibleCounts', 'items', 'targets'],
    [
      { code: 'sync', level: 'list', requires: 'create' },
      { code: 'retry', level: 'detail', requires: 'update' },
      { code: 'abort', level: 'detail', requires: 'update' },
    ],
  ),
} as const satisfies Record<string, ObjectDefinition>;

export type SuccessionObject = keyof typeof SUCCESSION_OBJECTS;

/** 审计日志的对象中文名（audit/labels.ts 统一展开）。 */
export const SUCCESSION_OBJECT_LABELS: Readonly<Record<SuccessionObject, string>> = {
  record: '继任记录',
  map: '继任地图',
  riskResult: '职位风险等级结果',
  healthResult: '组织健康度结果',
  riskLevel: '职位风险等级',
  healthLevel: '组织健康度等级',
  population: '人员范围',
  ruleSettings: '风险与健康度默认颜色',
  calcRun: '继任计算任务',
  syncBatch: '盘点同步批次',
};

/** 没有组织字段的规则配置对象：数据范围只认看全部（§8.1，DEC-121 由标准管理员预置）。 */
export const SUCCESSION_CONFIG_OBJECTS: readonly SuccessionObject[] = [
  'riskLevel',
  'healthLevel',
  'population',
  'ruleSettings',
];

/** 有组织锚点的业务对象：范围按目标组织 / 职位所属组织 / 组织（§8.1 范围锚点列）。 */
export const SUCCESSION_ORG_OBJECTS: readonly SuccessionObject[] = ['record', 'map', 'riskResult', 'healthResult'];

/** 任务对象：整体可见按逐对象 / 逐目标归属判定（§8.4），不按单一组织锚点。 */
export const SUCCESSION_TASK_OBJECTS: readonly SuccessionObject[] = ['calcRun', 'syncBatch'];
