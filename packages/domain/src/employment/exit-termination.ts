/**
 * 离职生效时终止在途流程（DEC-725，取代 DEC-496① / DEC-266④ / DEC-263②；规格 30 SwitchTypes=41、DM-R8）。
 * 28 类流程按“流程类型”逐类勾选；本租户预置勾选 27 类，只有“新建合同协议”不勾（规格 30 §离职退休设置）。
 * 未勾选时的默认口径按组区分：
 * - 任职组：只终止计划生效日晚于最后工作日 L 的；存在计划日 ≤ L 的劳务转正式 / 实习转正审批中流程时不能发起离职；
 * - 合同组：只终止“终止日期”晚于 L 的；
 * - 考核组、个人信息组：勾选才终止，不勾一律保留。
 * 配置存两层配置 `exit.termination_flow_types`（{ 流程码: 是否勾选 }）；缺的键按预置取，未知键与非布尔值拒绝保存。
 */

export const EXIT_TERMINATION_SETTING_KEY = 'exit.termination_flow_types';

export type ExitTerminationGroup = 'employment' | 'contract' | 'assessment' | 'personal';

/** 28 类流程：编码 → 分组与界面名称（顺序同原站设置页）。 */
export const EXIT_TERMINATION_FLOWS = {
  regularization: { group: 'employment', name: '转正' },
  transfer: { group: 'employment', name: '调动' },
  inter_org_transfer: { group: 'employment', name: '机构间调动' },
  batch_transfer: { group: 'employment', name: '批量调动' },
  labor_regularization: { group: 'employment', name: '劳务转正式' },
  intern_regularization: { group: 'employment', name: '实习转正' },
  // 固定终止（不可取消勾选）：离职后不能再新增兼职，见 EXIT_TERMINATION_FIXED
  part_time_add: { group: 'employment', name: '新增兼职', fixed: true },
  part_time_extend: { group: 'employment', name: '延长兼职' },
  part_time_end: { group: 'employment', name: '结束兼职' },
  contract_create: { group: 'contract', name: '新建合同协议' },
  contract_renew: { group: 'contract', name: '续签合同协议' },
  contract_change: { group: 'contract', name: '变更合同协议' },
  contract_terminate: { group: 'contract', name: '终止合同协议' },
  probation_assessment: { group: 'assessment', name: '试用中考核' },
  regularization_assessment: { group: 'assessment', name: '转正考核' },
  emp_info_change: { group: 'personal', name: '个人信息变更' },
  onboarding_info_collect: { group: 'personal', name: '在职信息采集' },
  education: { group: 'personal', name: '教育经历变更' },
  family: { group: 'personal', name: '家庭成员变更' },
  jobhistory: { group: 'personal', name: '工作经历变更' },
  training: { group: 'personal', name: '培训经历变更' },
  'project-experience': { group: 'personal', name: '项目经历变更' },
  awards: { group: 'personal', name: '获奖情况变更' },
  'language-ability': { group: 'personal', name: '语言能力变更' },
  skill: { group: 'personal', name: '专业技能变更' },
  punish: { group: 'personal', name: '惩处记录变更' },
  certificate: { group: 'personal', name: '证书变更' },
  retirement_intention: { group: 'personal', name: '意向退休日期申请' },
} as const satisfies Record<string, { group: ExitTerminationGroup; name: string; fixed?: true }>;

export type ExitTerminationFlow = keyof typeof EXIT_TERMINATION_FLOWS;
export const EXIT_TERMINATION_FLOW_CODES = Object.keys(EXIT_TERMINATION_FLOWS) as ExitTerminationFlow[];
export type ExitTerminationSetting = Readonly<Record<ExitTerminationFlow, boolean>>;

/** 本租户预置（迁移 0180 写入系统值时与此一致，由测试核对）。 */
export const EXIT_TERMINATION_PRESET: ExitTerminationSetting = Object.fromEntries(
  EXIT_TERMINATION_FLOW_CODES.map((code) => [code, code !== 'contract_create']),
) as ExitTerminationSetting;

const isFlow = (code: string): code is ExitTerminationFlow => Object.hasOwn(EXIT_TERMINATION_FLOWS, code);

/** 固定终止、不可取消勾选的流程（目录里标 fixed）：保存 false 拒绝，读到 false 也按勾选处理。 */
export const EXIT_TERMINATION_FIXED: readonly ExitTerminationFlow[] = EXIT_TERMINATION_FLOW_CODES.filter(
  (code) => 'fixed' in EXIT_TERMINATION_FLOWS[code],
);

/** 读取口径：必须是对象，键都是已知流程码，值都是布尔。 */
function isBooleanMap(value: unknown): value is Partial<ExitTerminationSetting> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([code, on]) => isFlow(code) && typeof on === 'boolean');
}

/** 保存校验：读取口径之外，固定终止的流程不能存 false（两层配置写入口 400 SETTING_VALUE_INVALID）。 */
export function validExitTerminationSetting(value: unknown): value is Partial<ExitTerminationSetting> {
  return isBooleanMap(value) && EXIT_TERMINATION_FIXED.every((code) => value[code] !== false);
}

/**
 * 有效勾选：配置缺的键按预置取；读到非法值（理论上保存时已拒）也回落到预置，不放宽为“全部保留”。
 * 固定终止的流程不论存的是什么都按勾选（直接写库绕过校验时也不放宽）。
 */
export function exitTerminationPolicy(value: unknown): ExitTerminationSetting {
  const stored = isBooleanMap(value) ? value : {};
  const fixed = Object.fromEntries(EXIT_TERMINATION_FIXED.map((code) => [code, true]));
  return { ...EXIT_TERMINATION_PRESET, ...stored, ...fixed };
}

/** 机构间调入表单（含门店首页）：任职侧据此把 kind=transfer 的申请归到“机构间调动”（transfer/catalog.ts 的 InterOrg 两张）。 */
export const INTER_ORG_TRANSFER_FORM_IDS: readonly string[] = [
  'TenantBase.InterOrgTransferMultiFormView',
  'TenantBase.IndustryOrgApplyForTransferFormView',
];
/** 批量调动表单 ID 前缀（原站批量调动，首版暂缓、尚无入口；入口落地后沿用此前缀即自带“批量调动”开关）。 */
export const BATCH_TRANSFER_FORM_ID_PREFIX = 'TenantBase.BatchTransfer';

/** 调动类申请（任职 kind=transfer）按表单归到三个独立开关之一。 */
export function transferFlow(formId: string | null | undefined): ExitTerminationFlow {
  if (formId && INTER_ORG_TRANSFER_FORM_IDS.includes(formId)) return 'inter_org_transfer';
  if (formId?.startsWith(BATCH_TRANSFER_FORM_ID_PREFIX)) return 'batch_transfer';
  return 'transfer';
}

/**
 * 任职业务 kind（+ 表单）→ 流程码；不在 28 类里的（入职、重聘、返聘、组织调整、退休）返回 null，照旧全部作废。
 * 调动 / 机构间调动 / 批量调动是三个独立开关（F-430①，F-421），任职侧都是 kind=transfer，靠表单区分（transferFlow），
 * 不得都归到 transfer——否则“调动”的勾选会误管另外两类。
 */
export function employmentKindFlow(kind: string, formId?: string | null): ExitTerminationFlow | null {
  if (kind === 'transfer') return transferFlow(formId);
  return ['regularization', 'labor_regularization', 'intern_regularization'].includes(kind)
    ? (kind as ExitTerminationFlow)
    : null;
}

/** 合同申请 operation（create / renew / change / terminate）→ 流程码。 */
export function contractOperationFlow(operation: string): ExitTerminationFlow | null {
  const code = `contract_${operation}`;
  return isFlow(code) ? code : null;
}

/** 兼职申请类型（add / extend / end）→ 流程码。 */
export function partTimeRequestFlow(requestType: string): ExitTerminationFlow | null {
  const code = `part_time_${requestType}`;
  return isFlow(code) ? code : null;
}

/** 考核类型（probation / regularization）→ 流程码。 */
export function assessmentTypeFlow(assessmentType: string): ExitTerminationFlow | null {
  const code = `${assessmentType}_assessment`;
  return isFlow(code) ? code : null;
}

/** 员工子集变更的子集 → 流程码；没有单独流程类型的子集归入“个人信息变更”。 */
export function personnelSubsetFlow(subset: string): ExitTerminationFlow {
  return isFlow(subset) && EXIT_TERMINATION_FLOWS[subset].group === 'personal' ? subset : 'emp_info_change';
}

/** 未勾选的任职 / 合同流程是否仍要终止：日期晚于 L（null = 无期限，视为晚于）。考核、个人信息组不勾即保留。 */
export function terminatedWhenUnticked(flow: ExitTerminationFlow, date: string | null, lastWorkDate: string) {
  const { group } = EXIT_TERMINATION_FLOWS[flow];
  if (group !== 'employment' && group !== 'contract') return false;
  return date === null || date > lastWorkDate;
}

/** 该流程在离职生效时是否终止。 */
export function terminatedByExit(
  policy: ExitTerminationSetting,
  flow: ExitTerminationFlow,
  date: string | null,
  lastWorkDate: string,
) {
  return policy[flow] || terminatedWhenUnticked(flow, date, lastWorkDate);
}

/** 未勾选、计划日 ≤ L 时拦离职的转正类（规格 30：劳务转正式、实习转正）。 */
export const EXIT_BLOCKING_REGULARIZATIONS = ['intern_regularization', 'labor_regularization'] as const;
