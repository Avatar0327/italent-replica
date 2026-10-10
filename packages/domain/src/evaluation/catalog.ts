/**
 * 人才评定的权限对象目录（DEC-080：真实字段与按钮；docs/02_业务建模/24、23 §9；R3-T02 设计 §3.2、§5.1）。
 * 人才评定是独立应用 TEvaluation：对象只能配置进、也只在登记了该应用的身份里生效，数据范围按（用户 × 应用）存一份
 * （DEC-043），缺省为空。
 * - 评价表、评审组、评定活动的“所属组织”是必填、手选的业务字段（原站 OIdDepartment / Organization，部门单选，
 *   Q-M0-132 🟢；DEC-324②）；所属人是系统字段。原站没有资源集合，也没有向下公开（设计 §5.1，不做）。
 * - 活动类型、活动周期、通用评分项没有组织字段（字典，DEC-121 同口径）。
 * 本目录只含配置对象（PR-A / PR-B）；员工评定数据等流程对象见 flow-catalog.ts（P0 契约冻结）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const EVALUATION_APP = 'TEvaluation';

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];
const crud: readonly ButtonDefinition[] = [
  { code: 'create', level: 'list', requires: 'create' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'detail', requires: 'delete' },
];

function object(code: string, fields: readonly string[], system: readonly string[] = []): ObjectDefinition {
  return {
    code: `${EVALUATION_APP}.${code}`,
    application: EVALUATION_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons: crud,
  };
}

const ACTIVITY_FLOW_BUTTONS: readonly ButtonDefinition[] = [
  { code: 'publish', level: 'list_row', requires: 'update' },
  { code: 'unpublish', level: 'list_row', requires: 'update' },
  { code: 'complete', level: 'list_row', requires: 'update' },
];

function withoutDelete(definition: ObjectDefinition): ObjectDefinition {
  return { ...definition, buttons: definition.buttons.filter((button) => button.code !== 'delete') };
}

function withButtons(definition: ObjectDefinition, buttons: readonly ButtonDefinition[]): ObjectDefinition {
  return { ...definition, buttons: [...definition.buttons, ...buttons] };
}

export const EVALUATION_OBJECTS = {
  /** 活动类型：无“同步任职记录”（DEC-025）。 */
  activityType: object('ActivityType', ['name', 'enabled', 'displayOrder', 'syncQualification']),
  activityCycle: object('ActivityCycle', ['name', 'enabled']),
  /** 通用评分项：首版只做评分。 */
  generalScoreItem: object('GeneralScoreItem', ['name', 'description', 'enabled']),
  /**
   * 评审组：成员随组整组编辑。照原站没有编码字段、没有删除入口（DEC-393①⑤），所以没有“删除”按钮，列表操作只有编辑 / 停用。
   */
  reviewGroup: withoutDelete(object('ReviewGroup', ['name', 'ownerOrgId', 'enabled', 'members'], ['ownerId'])),
  /** 评价表（标准模式）：评分项随表整组编辑。没有编码字段（照评审组 DEC-393 的经验，原站未证实，#216）。 */
  evaluationForm: object(
    'EvaluationForm',
    ['name', 'ownerOrgId', 'enabled', 'scoreMode', 'fullScore', 'passScore', 'totalRule', 'items'],
    ['ownerId'],
  ),
  /**
   * 评定活动：参评条件与环节随活动整份提交；状态与报名数由流程维护（只读）。行操作发布 / 取消发布 / 完成（规格 24
   * EV-R14 / R15、Q-M0-136）是活动级整体操作（设计 §5.1），按钮由 P0 契约随流程对象一起冻结。
   */
  evaluationActivity: withButtons(
    object(
      'EvaluationActivity',
      [
        'code',
        'name',
        'typeId',
        'cycleId',
        'year',
        'startDate',
        'endDate',
        'ownerOrgId',
        'orgRange',
        'managerEmployeeId',
        'applicantMode',
        'categoryIds',
        'levelIds',
        'maxLevelJump',
        'effectiveDate',
        'noticeOrgRange',
        'conditions',
        'chains',
      ],
      ['ownerId', 'status', 'applyCount'],
    ),
    ACTIVITY_FLOW_BUTTONS,
  ),
} as const satisfies Record<string, ObjectDefinition>;

export type EvaluationObject = keyof typeof EVALUATION_OBJECTS;

/** 按所属组织（手选）控制数据范围的对象；其余为字典。 */
export const EVALUATION_ORG_OBJECTS: readonly EvaluationObject[] = [
  'reviewGroup',
  'evaluationForm',
  'evaluationActivity',
];

/** 审计动作前缀（`<前缀>.create|update|delete`）。 */
export const EVALUATION_AUDIT_ACTIONS: Readonly<Record<EvaluationObject, string>> = {
  activityType: 'evaluation.activity-type',
  activityCycle: 'evaluation.activity-cycle',
  generalScoreItem: 'evaluation.general-score-item',
  reviewGroup: 'evaluation.review-group',
  evaluationForm: 'evaluation.form',
  evaluationActivity: 'evaluation.activity',
};
