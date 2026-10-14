/**
 * 人才评定的流程对象目录（R3-T02 P0 契约，拆分方案第 3 节①；设计 §3.3、§5.1；规格 24 §2）。
 * 先于 C1 / C2 冻结：C1-2 装评定专员身份时要引用这些对象（standard-profiles.ts 按目录校验），C2 各子 PR 只用、不改；
 * 字段或按钮缺漏时由契约小 PR 追加，并经 DEC-361 登记表给已装身份补授权。
 * - 与配置对象（catalog.ts）分开登记：配置对象的审计规则（字典 / 所属组织）不适用于流程对象，流程对象的审计按
 *   “活动谓词 ∧ 人员范围”（设计 §5.1 activityPersonRule），规则体由 C2-1a 注入（audit/visibility.ts）。
 * - 字段名是设计 §3.3 列名的驼峰写法；由系统维护的列（归属、快照、分阶段状态、流程实例、终止 / 发布时间）是系统字段，
 *   编辑不可授（AC-PRM-23）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';
import { EVALUATION_APP } from './catalog.js';

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];

function object(
  code: string,
  fields: readonly string[],
  system: readonly string[],
  buttons: readonly ButtonDefinition[] = [],
): ObjectDefinition {
  return {
    code: `${EVALUATION_APP}.${code}`,
    application: EVALUATION_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...system, ...SYSTEM_FIELDS].map((field) => ({ code: field, system: true })),
    ],
    buttons,
  };
}

/**
 * 员工评定数据的按钮（规格 24 已知入口）：提名 / 批量提名（EV-R22）、转入下一环节（EV-R13 / R29）、提前通知（EV-R42）、
 * 发布结果、撤销申报（EV-R23，= 终止）；编辑 / 删除草稿走数据操作。
 */
const STAFF_EVALUATION_BUTTONS: readonly ButtonDefinition[] = [
  { code: 'nominate', level: 'list', requires: 'create' },
  { code: 'transfer', level: 'list', requires: 'update' },
  { code: 'advanceNotice', level: 'list' },
  { code: 'publishResult', level: 'list', requires: 'update' },
  { code: 'revoke', level: 'list', requires: 'update' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'list_row', requires: 'delete' },
];

export const EVALUATION_FLOW_OBJECTS = {
  /** 一人一活动一条（设计 §3.3 ev_staff_evaluations）。 */
  staffEvaluation: object(
    'StaffEvaluationData',
    [
      'activityId',
      'employeeId',
      'applyCategoryId',
      'applyLevelId',
      'exception',
      'exceptionReason',
      'selfEvaluation',
      'managerEvaluation',
      'hrbpEvaluation',
      'defenseMaterial',
      'finalScore',
      'finalResult',
      'strengths',
      'suggestions',
      'effectiveDate',
    ],
    [
      'cycleId',
      'targetVersion',
      'source',
      'initiatorUserId',
      'nominatorEmployeeId',
      'appliedAt',
      'originalCategoryId',
      'originalLevelId',
      'lastResult',
      'experience',
      'standardId',
      'conditionResult',
      'currentStage',
      'applyStatus',
      'materialStatus',
      'defenseStatus',
      'resultStatus',
      'qualificationInstanceId',
      'materialInstanceId',
      'defenseMaterialUpdatedBy',
      'defenseMaterialUpdatedAt',
      'passVotes',
      'terminatedAt',
      'terminatedReason',
      'publishedAt',
    ],
    STAFF_EVALUATION_BUTTONS,
  ),
  /** 一人 × 一评分项（ev_indicator_items）：自评 / 上级 / 预置分与评价；快照与冻结由系统维护（DEC-153）。 */
  indicatorItem: object(
    'EvaluationIndicatorsDetail',
    ['selfScore', 'selfComment', 'managerScore', 'managerComment', 'presetScore', 'presetComment'],
    ['staffEvaluationId', 'chainId', 'itemKey', 'weight', 'snapshot', 'frozenAt', 'targetVersion'],
  ),
  /** 评审场次（ev_sessions）：安排评审 = 新增，“确定并发送通知”后 status = sent。 */
  session: object(
    'EvaluationSessions',
    ['name', 'reviewGroupId', 'judgeEmployeeIds', 'followerEmployeeId', 'startAt', 'minutesPerPerson', 'location'],
    ['activityId', 'chainId', 'status'],
    [
      { code: 'create', level: 'list', requires: 'create' },
      { code: 'update', level: 'detail', requires: 'update' },
      { code: 'delete', level: 'detail', requires: 'delete' },
    ],
  ),
  /** 场次明细 = 每个参评人的时段（ev_session_slots）：答辩状态由跟场人推进；minutes 为纪要。 */
  sessionSlot: object(
    'EvaluationSessionsDetail',
    ['staffEvaluationId', 'seq', 'startAt', 'endAt', 'minutes'],
    ['sessionId', 'defenseState'],
  ),
  /** 评委评审记录（ev_judge_records）：弃权按钮 TEvaluation.EvaluationRecord / Abstain（规格 24 EV-R31 🟢）。 */
  judgeRecord: object(
    'EvaluationRecord',
    ['totalScore', 'result', 'strengths', 'suggestions', 'abstainReason'],
    ['slotId', 'staffEvaluationId', 'targetVersion', 'judgeEmployeeId', 'status', 'abstainBy', 'submittedAt'],
    [{ code: 'Abstain', level: 'detail' }],
  ),
  /** 评委逐项打分（ev_judge_scores）。 */
  judgeScore: object('EvaluationRecordDetail', ['score', 'comment'], ['judgeRecordId', 'itemKey']),
} as const satisfies Record<string, ObjectDefinition>;

export type EvaluationFlowObject = keyof typeof EVALUATION_FLOW_OBJECTS;

/** 审计动作前缀（`<前缀>.create|update|delete`，C2 各子 PR 写审计时用）。 */
export const EVALUATION_FLOW_AUDIT_ACTIONS: Readonly<Record<EvaluationFlowObject, string>> = {
  staffEvaluation: 'evaluation.staff-evaluation',
  indicatorItem: 'evaluation.indicator-item',
  session: 'evaluation.session',
  sessionSlot: 'evaluation.session-slot',
  judgeRecord: 'evaluation.judge-record',
  judgeScore: 'evaluation.judge-score',
};
