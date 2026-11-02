// FE-R2c1b 试用设置页的冒烟夹具：形态与真实接口一致（tests/acceptance/AC-FE-R2c1b-settings 用真实接口核对）。
// 本文件不引用 playwright，供 vitest 直接读取；数据全部为合成值。
export { otherSettingsMenu } from './account-stop-fixtures.js';
export { settingsPermission } from './exit-fixtures.js';

export const department = '60000000-0000-4000-8000-0000000000b1';
export const operator = '70000000-0000-4000-8000-0000000000b1';
let sequence = 0;
/** 合成行 id：固定前缀 + 递增序号，形如 UUID。 */
export const rowId = () => `a1000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

/** 试用结果字典行：GET /probation-results 的 items 项固定六个键；预置三项（DEC-361 种子，显示顺序 10 / 20 / 30）。 */
export interface ResultRow {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  displayOrder: number;
  revision: number;
}
export const resultPresets = (): ResultRow[] =>
  [
    { code: 'normal', name: '正常转正' },
    { code: 'early', name: '提前转正' },
    { code: 'delayed', name: '延期转正' },
  ].map((row, index) => ({ id: rowId(), ...row, enabled: true, displayOrder: (index + 1) * 10, revision: 1 }));

/** 自动转正规则（B57）整条视图：auto-regularization-rules.ts AutoRegularizationRuleView 的十二个键。 */
export const regularizationRule = (extra: Record<string, unknown> = {}) => ({
  id: rowId(),
  name: 'ZZ_到期当天自动发起转正申请',
  priority: 1,
  orgIds: [department],
  includeSubordinates: true,
  mode: 'application',
  daysBefore: 0,
  initiatorType: 'rule_operator',
  probationResult: 'normal',
  enabled: true,
  operatorUserId: operator,
  revision: 1,
  ...extra,
});
/** 自动发起考核规则（B58）整条视图：auto-assessment-rules.ts 的十一个键。 */
export const assessmentRule = (extra: Record<string, unknown> = {}) => ({
  id: rowId(),
  name: 'ZZ_入职 30 天发起试用中考核',
  priority: 1,
  orgIds: [department],
  includeSubordinates: true,
  assessmentType: 'probation',
  daysAfterEntry: 30,
  initiatorType: 'department_head',
  enabled: true,
  operatorUserId: operator,
  revision: 1,
  ...extra,
});
export const COPY_SUFFIX = '（复制）';

/** 两层配置回显（tenant-settings/service.ts EffectiveSetting 六个键）；从未覆盖时 source = system、revision = 0。 */
export const setting = (key: string, value: unknown, revision = 0) => ({
  key,
  value,
  source: revision ? 'tenant' : 'system',
  revision,
  systemVersion: 1,
  overridable: true,
});
export const SWITCH_KEYS = {
  regularization: 'probation.auto_regularization_enabled',
  assessment: 'probation.auto_assessment_enabled',
} as const;
export const PARALLEL_KEYS = {
  probation_assessment: 'probation.assessment_parallel.probation_assessment',
  regularization_assessment: 'probation.assessment_parallel.regularization_assessment',
} as const;
export const parallelDefault = { enabled: false, allowed: [] as string[] };

/**
 * 立即执行的失败项（auto-regularization.ts AutoRegularizationFailed / auto-assessment.ts AutoAssessmentFailed）：三个键，
 * reason 为 details.reason，拿不到时退回通用错误码（reasonOf）。B57 每人至多一条；B58 按规则逐条办理，同一人可有多条。
 */
export const runFailure = (employeeId: string, ruleId: string, reason: string) => ({ employeeId, ruleId, reason });
/** 立即执行回执（auto-regularization.ts / auto-assessment.ts）：逐人列出发起 / 失败与续跑游标。 */
export const runReceipt = {
  regularization: (employeeId: string, ruleId: string, nextCursor: string | null = null) => ({
    businessDate: '2026-10-01',
    launched: [{ employeeId, ruleId, businessId: rowId(), businessStatus: 'in_review', initiatorUserId: operator }],
    failed: [] as ReturnType<typeof runFailure>[],
    nextCursor,
  }),
  assessment: (employeeId: string, ruleId: string, nextCursor: string | null = null) => ({
    businessDate: '2026-10-01',
    launched: [{ employeeId, ruleId, assessmentId: rowId(), assessmentStatus: 'in_review', initiatorUserId: operator }],
    failed: [] as ReturnType<typeof runFailure>[],
    nextCursor,
  }),
};
/** 总开关关闭时立即执行的明确拒绝（409 CONFLICT，details.reason 区分）。 */
export const runDisabled = {
  regularization: {
    error: { code: 'CONFLICT', message: '自动转正未开启', details: { reason: 'AUTO_REGULARIZATION_DISABLED' } },
  },
  assessment: {
    error: { code: 'CONFLICT', message: '自动发起试用期考核未开启', details: { reason: 'AUTO_ASSESSMENT_DISABLED' } },
  },
};
export const revisionConflict = { error: { code: 'REVISION_CONFLICT', message: '任职数据已变更，请刷新后显式重提' } };
export const resultCodeTaken = {
  error: { code: 'CONFLICT', message: '试用结果编码已存在', details: { reason: 'PROBATION_RESULT_CODE_TAKEN' } },
};
