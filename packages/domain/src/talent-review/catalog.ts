/**
 * 人才盘点的权限对象目录（R3-T04 设计 §6.1；DEC-080 真实字段与按钮）。人才盘点是独立应用 `TalentReview`：
 * 对象只能配置进、也只在登记了该应用的身份里生效，数据范围按（用户 × TalentReview）存一份（DEC-043），缺省为空。
 * PR-A 只登记本 PR 交付的对象（准备度字典、结果审批的业务对象）；项目、模板、对象等随 PR-B～PR-D 在本文件追加，
 * 标准身份、审计标签与审计查看规则都从这里取，后续 PR 不再改共享文件（设计 §12）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const TALENT_REVIEW_APP = 'TalentReview';
/** 审计日志「应用」列（docs/02_业务建模/20 §2）。 */
export const TALENT_REVIEW_APP_LABEL = '人才盘点';

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];
const crud: readonly ButtonDefinition[] = [
  { code: 'create', level: 'list', requires: 'create' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'detail', requires: 'delete' },
];

function object(
  code: string,
  fields: readonly string[],
  system: readonly string[] = [],
  buttons: readonly ButtonDefinition[] = crud,
): ObjectDefinition {
  return {
    code: `${TALENT_REVIEW_APP}.${code}`,
    application: TALENT_REVIEW_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons,
  };
}

export const TALENT_REVIEW_OBJECTS = {
  /**
   * 准备度共享字典（DEC-301①；`27` §1 Readiness：阶段、描述、颜色、排序）。设置类配置对象，没有组织字段：
   * 只认看全部或创建人（DEC-121），新建只有看全部可建（DEC-082）。编码建后不可改（引用方同时保存 id 与 code）。
   */
  readiness: object('Readiness', ['code', 'name', 'description', 'color', 'sortNo', 'enabled']),
  /** 盘点租户设置（设计 §2.2 settings）：单例资源，只有更新入口；没有组织字段，读写都要看全部。 */
  settings: object(
    'Settings',
    ['allowSecondaryKeyPositionNomination', 'selfResultVisible', 'doneHideSuccession', 'systemPrincipalUserId'],
    [],
    [{ code: 'update', level: 'detail', requires: 'update' }],
  ),
  /** 盘点分类（TR-R9）。设置类配置对象，没有组织字段（DEC-121）。 */
  category: object('Category', ['name', 'sortNo', 'enabled']),
  /** 盘点角色（设计 §3.4）：评价流程步骤的执行人角色，编码建后不可改。 */
  role: object('Role', ['code', 'name', 'resolver', 'sortNo', 'enabled']),
  /** 盘点字段目录（设计 §2.2）：预置与自定义一视同仁；选项随字段整组维护（options 是嵌套字段，权限随字段）。 */
  field: object('Field', [
    'code',
    'name',
    'kind',
    'group',
    'preset',
    'systemWritten',
    'pairRole',
    'pairFieldId',
    'precision',
    'options',
    'sortNo',
    'enabled',
  ]),
  /** 评价规则（TR-R20）：数值类 / 等级类；等级随规则整组维护。设置类配置对象（DEC-121）。 */
  scoreRule: object('ScoreRule', [
    'name',
    'kind',
    'minScore',
    'maxScore',
    'display',
    'allowUnable',
    'levels',
    'enabled',
  ]),
  /** 模块等级（TR-R15 / R20）：得分区间或按指标数目的等级项，随模块等级整组维护。 */
  moduleGrade: object('ModuleGrade', ['name', 'mode', 'items', 'enabled']),
  /** 字段映射（TR-R9）：带入上次结果 / 入人才池的来源 → 目标字段；预置“标签 → 标签”。 */
  mapping: object('FieldMapping', ['scene', 'sourceFieldId', 'targetFieldId', 'preset']),
  /**
   * 九宫格（设计 §2.2；TR-R31～R35）：轴、分段、格子、位置字段占用与比例规则组随九宫格整体维护（均为嵌套字段，权限随字段）。
   * 设置类配置对象，没有组织字段（DEC-121）。
   */
  matrix: object('Matrix', [
    'code',
    'name',
    'xFieldId',
    'yFieldId',
    'zFieldId',
    'xDraggable',
    'yDraggable',
    'placementSource',
    'greenRateReference',
    'preset',
    'positionFields',
    'axisLevels',
    'cells',
    'ratioGroups',
    'sortNo',
    'enabled',
  ]),
  /**
   * 盘点计算规则（设计 §2.2；TR-R27～R30）：计算项目随规则整体维护（items 是嵌套字段，权限随字段）；`hints` 是保存时返回的
   * 排序 / 循环 / 依赖矛盾提示（派生，不可写）。设置类配置对象，没有组织字段（DEC-121）。
   */
  calcRule: object(
    'CalcRule',
    ['name', 'enabled', 'assessmentLatestWindow', 'description', 'items', 'sortNo'],
    ['hints'],
  ),
  /**
   * 盘点结果审批（设计 §3.3、§2.6；N12）：审批类型 talent_review_result 的业务对象（集合审批，一单多个被盘点人）。
   * 发起 / 撤回入口随 PR-D 接入；本 PR 只登记对象，供审批类型与标准身份引用。
   */
  resultApproval: object(
    'ResultApproval',
    ['projectId', 'scopeOrgIds', 'details'],
    ['status', 'approvalInstanceId', 'initiatedBy', 'subjectEmployeeIds'],
    [
      { code: 'create', level: 'list', requires: 'create' },
      { code: 'withdraw', level: 'detail', requires: 'update' },
    ],
  ),
} as const satisfies Record<string, ObjectDefinition>;

export type TalentReviewObject = keyof typeof TALENT_REVIEW_OBJECTS;

/** 审计日志的对象中文名（audit/labels.ts 统一展开，后续 PR 只在这里追加）。 */
export const TALENT_REVIEW_OBJECT_LABELS: Readonly<Record<TalentReviewObject, string>> = {
  readiness: '准备度',
  settings: '盘点设置',
  category: '盘点分类',
  role: '盘点角色',
  field: '盘点字段',
  scoreRule: '评价规则',
  moduleGrade: '模块等级',
  mapping: '字段映射',
  matrix: '盘点九宫格',
  calcRule: '盘点计算规则',
  resultApproval: '盘点结果审批',
};

/** 没有组织字段的设置类对象：数据范围只认看全部或创建人（DEC-121）。 */
export const TALENT_REVIEW_CONFIG_OBJECTS: readonly TalentReviewObject[] = [
  'readiness',
  'settings',
  'category',
  'role',
  'field',
  'scoreRule',
  'moduleGrade',
  'mapping',
  'matrix',
  'calcRule',
];

/** 准备度颜色：#RRGGBB（原站字典每项带颜色，`27` 补充 W-617）。 */
export const READINESS_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
