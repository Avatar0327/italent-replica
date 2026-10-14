/**
 * 个人发展计划 IDP 的权限对象目录与枚举（docs/02_业务建模/28 §1、§2 与 Q-M0-115 补充；DEC-080 真实字段与按钮）。
 * IDP 是独立应用 `IDP`（`28` 边界，挂在「继任与发展」菜单下）：对象只能配置进、也只在登记了该应用的身份里生效，
 * 数据范围按（用户 × IDP）存一份（DEC-043），缺省为空。
 * 库内存英文代码；原站数字编号写在注释里，供导入映射（Q-M0-115 ①②④）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const IDP_APP = 'IDP';

/** 子流程类别（SubProcess.类别）：制定计划 1 / 回顾 2 / 总结评价 3。名称与类别不必一致（Q-M0-115 样本）。 */
export const SUB_PROCESS_CATEGORIES = ['plan', 'review', 'evaluation'] as const;
export type SubProcessCategory = (typeof SUB_PROCESS_CATEGORIES)[number];

/**
 * 子流程关联的审批流程类别（SubProcess.名称 / 关联审批流程）：制定计划 1 / 中期回顾 2 / 末期回顾 3。
 * 对应审批中心的三个 IDP 审批类型（DEC-017 按类型隔离），子流程另指定该类型下一条已发布流程（口径 K-08）。
 */
export const IDP_APPROVAL_TYPES = ['idp_plan', 'idp_mid_review', 'idp_final_review'] as const;
export type IdpApprovalType = (typeof IDP_APPROVAL_TYPES)[number];

/** 开启方式：自动 1 / 手动 100。 */
export const START_MODES = ['auto', 'manual'] as const;
export type StartMode = (typeof START_MODES)[number];

/** 发起时间类型：固定时间 0 / 相对时间 1；自动开启不设规则时为空（= 上一阶段结束即开启，K-06）。 */
export const START_TIME_TYPES = ['fixed', 'relative'] as const;
export type StartTimeType = (typeof START_TIME_TYPES)[number];

/** 参照时间点：发展计划开始时间、发展计划结束时间、上一阶段结束时间、任职记录.生效时间。 */
export const REFERENCE_POINTS = ['plan_start', 'plan_end', 'previous_end', 'employment_effective'] as const;
export type ReferencePoint = (typeof REFERENCE_POINTS)[number];

/** 始于：当天 0 / 前 N 天 1 / 后 N 天 2。 */
export const START_FROM = ['same_day', 'before', 'after'] as const;
export type StartFrom = (typeof START_FROM)[number];

/**
 * 模板模块类型（moduleType）：基本信息 0、发展目标 2、回顾 3、总结 4、综述 6（Q-M0-115④）；
 * 关键信息、盘点结果的原站编号未取到，复刻记作 1 / 5（🟡 K-10）。
 */
export const MODULE_TYPES = ['basic', 'key_info', 'goal', 'review', 'summary', 'talent_review', 'analysis'] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** 胜任力来源五选（IDP-R8）；“所属人才池”取出池标准（G-056 ✅）。原站编号未取到（🟡 K-13）。 */
export const COMPETENCY_SOURCES = [
  'current_position',
  'succession_position',
  'rotation_position',
  'promotion_position',
  'talent_pool',
] as const;
export type CompetencySource = (typeof COMPETENCY_SOURCES)[number];

/** 关键信息来源（IDP-R7）：职业发展、轮岗、带教、储备人才（人才池）。 */
export const KEY_INFO_SOURCES = ['career', 'work_shift', 'tutorship', 'talent_pool'] as const;
export type KeyInfoSource = (typeof KEY_INFO_SOURCES)[number];

/**
 * 关键信息区块的可选展示字段与缺省展示字段（DEC-318 K-35 补充，取证 8db4dc6d：每个区块展示哪些字段在模板里配置）。
 * 🟡 可选字段按现有数据字段推断（原站“新增区块”的选项未实测）；缺省按取证样本（轮岗：部门、职位、职务、导师、起止；
 * 带教：带教人、起止；职业发展：拟晋升职位、优势项、待发展项、起止）。储备人才区块待 R3-T06（K-16），暂无字段。
 */
export const KEY_INFO_BLOCK_FIELDS: Readonly<
  Record<KeyInfoSource, { readonly options: readonly string[]; readonly defaults: readonly string[] }>
> = {
  career: {
    options: [
      'employeeId',
      'targetPositionId',
      'strengths',
      'developmentItems',
      'intendedCity',
      'startDate',
      'endDate',
    ],
    defaults: ['targetPositionId', 'strengths', 'developmentItems', 'startDate', 'endDate'],
  },
  work_shift: {
    options: ['employeeId', 'orgId', 'positionId', 'postId', 'mentorEmployeeId', 'startDate', 'endDate'],
    defaults: ['orgId', 'positionId', 'postId', 'mentorEmployeeId', 'startDate', 'endDate'],
  },
  tutorship: {
    options: ['tutorEmployeeId', 'tuteeEmployeeId', 'startDate', 'endDate', 'remark'],
    defaults: ['tutorEmployeeId', 'startDate', 'endDate'],
  },
  talent_pool: { options: [], defaults: [] },
};

export interface KeyInfoBlock {
  readonly block: KeyInfoSource;
  readonly fields: readonly string[];
}

/**
 * 区块配置的存储形式：区块顺序存 key_info_sources，各区块选定的展示字段存 key_info_fields（“区块.字段”）；某区块没有
 * 选定字段即取缺省展示字段。
 */
export function keyInfoBlocksOf(sources: readonly KeyInfoSource[], encoded: readonly string[] | null): KeyInfoBlock[] {
  return sources.map((block) => {
    const chosen = (encoded ?? []).filter((f) => f.startsWith(`${block}.`)).map((f) => f.slice(block.length + 1));
    return { block, fields: chosen.length ? chosen : [...KEY_INFO_BLOCK_FIELDS[block].defaults] };
  });
}

/** 区块配置 → 存储形式；只记与缺省不同的区块。 */
export function encodeKeyInfoBlocks(blocks: readonly { block: KeyInfoSource; fields?: readonly string[] }[]) {
  return {
    keyInfoSources: blocks.map((b) => b.block),
    keyInfoFields: blocks.flatMap((b) => (b.fields ?? []).map((field) => `${b.block}.${field}`)),
  };
}

/** 盘点结果模块：时间基准取盘点项目开始 / 结束时间，计划基准取计划开始 / 结束时间（IDP-R11）。 */
export const REVIEW_TIME_BASES = ['project_start', 'project_end'] as const;
export const PLAN_TIME_BASES = ['plan_start', 'plan_end'] as const;

/**
 * 按流程节点配置的可用按钮（DEC-296④，Q-M0-115④ activitySettings.buttonList）。学习计划的“编辑 / 发布学习计划”
 * 不做（派发“不做”）。综述 / 回顾 / 总结模块原站另有节点设置但结构未取证，复刻用“填写本模块”（🟡 K-12）。
 */
export const GOAL_NODE_BUTTONS = ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal'] as const;
export const CONTENT_NODE_BUTTONS = ['EditModuleContent'] as const;
export type NodeButton = (typeof GOAL_NODE_BUTTONS)[number] | (typeof CONTENT_NODE_BUTTONS)[number];

/** 自动开启统一在凌晨 2 点（租户时区，DEC-296⑤ / DEC-056）。 */
export const AUTO_START_HOUR = 2;

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
    code: `${IDP_APP}.${code}`,
    application: IDP_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons,
  };
}

/** 子流程的可写字段（嵌套在流程里整组提交）。 */
export const SUB_PROCESS_FIELDS = [
  'name',
  'category',
  'approvalType',
  'approvalProcessId',
  'endNoticeTemplate',
  'startMode',
  'startTimeType',
  'fixedDate',
  'referencePoint',
  'startFrom',
  'days',
] as const;

/** 模板模块的可写字段（各模块类型只用其中一部分，其余为空）。 */
export const TEMPLATE_MODULE_FIELDS = [
  'moduleType',
  'name',
  'description',
  'displayOrder',
  'allowCustomGoal',
  'allowLibraryGoal',
  'competencySource',
  'goalReviewEnabled',
  'taskEnabled',
  'checkNoneGoal',
  'keyInfoSources',
  'keyInfoBlocks',
  'reviewTimeBasis',
  'planTimeBasis',
  'reviewCategoryIds',
  'nodeSettings',
] as const;

/** 发展计划的可写字段（IDP-R13）。 */
export const PLAN_FIELDS = [
  'name',
  'employeeId',
  'templateId',
  'startDate',
  'endDate',
  'tutorRole',
  'tutorEmployeeId',
] as const;

/** 发展目标字段（IDP-R8；胜任力库目标另存指标的名称 / 定义 / 类别快照，DEC-307）。 */
export const GOAL_FIELDS = [
  'moduleId',
  'name',
  'measure',
  'suggestion',
  'startDate',
  'endDate',
  'indicatorId',
  'indicatorName',
  'indicatorDefinition',
  'indicatorCategory',
  'displayOrder',
] as const;

export const TASK_FIELDS = ['goalId', 'name', 'description', 'ownerEmployeeId', 'startDate', 'endDate'] as const;

export const CAREER_FIELDS = [
  'employeeId',
  'targetPositionId',
  'strengths',
  'developmentItems',
  'intendedCity',
  'startDate',
  'endDate',
] as const;

/** 计划状态（Q-M0-115① IdpStatus）：未开始 0 / 进行中 1 / 已结束 100 / 已终止 200。 */
export const PLAN_STATUSES = ['not_started', 'running', 'ended', 'terminated'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** 阶段（子流程实例）状态：待开启 / 进行中 / 已结束 / 开启失败（IDP-R3）。 */
export const STAGE_STATUSES = ['pending', 'running', 'ended', 'failed'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * 指导人角色（Q-M0-115① IDP.TutorRole）：直线经理 1、间接经理 2、第三 / 四 / 五级主管 3 / 4 / 5、导师 6、部门 HRBP 11、
 * 部门负责人 12、其他人 0（与人才池的枚举不同）。
 */
export const TUTOR_ROLES = [
  'direct_manager',
  'indirect_manager',
  'level3_head',
  'level4_head',
  'level5_head',
  'mentor',
  'department_hrbp',
  'department_head',
  'other',
] as const;
export type TutorRole = (typeof TUTOR_ROLES)[number];

/** 开启下个阶段时已有进行中阶段的处理（Q-M0-115① StartNextSubProcessType）：不处理 0 / 结束当前阶段并开启 1。 */
export const START_NEXT_MODES = ['skipRunning', 'endRunning'] as const;
export type StartNextMode = (typeof START_NEXT_MODES)[number];

/** 计划进行中、没有运行中的阶段、仍有未开启阶段时的“当前阶段”显示值（IDP-R4，🟡 K-03）。 */
export const IMPROVING_STAGE_NAME = '努力提升中';

export const IDP_OBJECTS = {
  /** 发展计划流程 IDPProcess：名称、所属组织、是否向下公开、是否启用；子流程是它的组成部分。 */
  process: object('IDPProcess', ['name', 'orgId', 'publicDown', 'enabled', 'subProcesses'], ['referenced']),
  /**
   * 子流程 SubProcess（顺序由流程内位置决定，seq 只读）。开启规则说明文本 ruleText 是派生值、不是可单独授权的字段：
   * 只在查看人看得到它所依据的全部字段（RULE_TEXT_SOURCES，含 fixedDate）时输出（DEC-309④）。
   */
  subProcess: object('SubProcess', SUB_PROCESS_FIELDS, ['seq'], []),
  /** 发展计划模板 IDPTemplate。 */
  template: object(
    'IDPTemplate',
    ['name', 'description', 'orgId', 'publicDown', 'processId', 'modules', 'commonGoals'],
    ['status', 'referenced'],
    [
      ...crud,
      { code: 'copy', level: 'detail', requires: 'create' },
      { code: 'publish', level: 'detail', requires: 'update' },
      { code: 'unpublish', level: 'detail', requires: 'update' },
    ],
  ),
  /** 发展计划模块 IDPTemplateModule（模块配置 + 按流程节点的可用按钮，DEC-296④）。 */
  templateModule: object('IDPTemplateModule', TEMPLATE_MODULE_FIELDS),
  /** 模板通用目标 IDPTemplateCommonGoal（只对之后新发起的计划生效，IDP-R9）。 */
  commonGoal: object('IDPTemplateCommonGoal', ['moduleId', 'name', 'measure', 'suggestion', 'displayOrder']),
  /**
   * 发展计划 Idp（PR-B）。HR 端按钮：新建 / 修改 / 删除 / 开始，流程干预（Q-M0-115⑥ 列表菜单）催办 / 跳转 / 开启下个阶段 /
   * 终止。阶段、当前步骤等由服务端维护，只读。干预审计记录的动作、原因、阶段、跳转目标节点（DEC-321）也是计划的只读
   * 字段，按字段查看权在审计里展示（第 4 轮 R3-2）。
   */
  plan: object(
    'Idp',
    PLAN_FIELDS,
    [
      'processId',
      'status',
      'currentStageName',
      'currentNodeName',
      'stages',
      'intervention',
      'reason',
      'stageId',
      'toNodeKey',
    ],
    [
      ...crud,
      { code: 'start', level: 'detail', requires: 'update' },
      { code: 'urge', level: 'list', requires: 'update' },
      { code: 'jump', level: 'detail', requires: 'update' },
      { code: 'transfer', level: 'detail', requires: 'update' },
      { code: 'startNext', level: 'list', requires: 'update' },
      { code: 'terminate', level: 'list', requires: 'update' },
    ],
  ),
  /** 发展目标 IdpGoal：执行人按节点按钮写（DEC-296④），HR 没有直接写入的按钮。 */
  goal: object('IdpGoal', GOAL_FIELDS, ['planId', 'sourceType', 'commonGoalId', 'tasks', 'reviews'], []),
  /** 目标任务 Task：执行人按节点按钮写；HR 只能统一下发（IDP-R15）。 */
  task: object('Task', TASK_FIELDS, ['planId'], [{ code: 'issue', level: 'list', requires: 'create' }]),
  /** 目标回顾 GoalReview（按阶段）。 */
  goalReview: object('GoalReview', ['goalId', 'stageId', 'progress', 'outcome'], [], []),
  /** 综述 Analysis。 */
  analysis: object('Analysis', ['moduleId', 'currentAnalysis', 'developmentItems'], [], []),
  /** 回顾 / 总结 Review（按阶段）。 */
  review: object('Review', ['moduleId', 'stageId', 'summary', 'improvement'], [], []),
  /** 带教信息 TutorShip（IDP-R19）。 */
  tutorship: object('TutorShip', ['tutorEmployeeId', 'tuteeEmployeeId', 'startDate', 'endDate', 'remark']),
  /** 职业发展信息 Career（IDP-R20；职务 / 职级等其余字段首版不做）。 */
  career: object('Career', CAREER_FIELDS),
  /** 轮岗信息 WorkShift（IDP-R21；职务 postId 随 DEC-318 K-35 补回，参与判重）。 */
  workShift: object('WorkShift', [
    'employeeId',
    'orgId',
    'positionId',
    'postId',
    'mentorEmployeeId',
    'startDate',
    'endDate',
  ]),
} as const satisfies Record<string, ObjectDefinition>;

export type IdpObject = keyof typeof IDP_OBJECTS;

/**
 * 同一份配置的几种表示（DEC-318 K-35 补充：关键信息区块 keyInfoBlocks 与旧的 keyInfoSources）：读写权限必须一起满足，
 * 不能用一个字段绕过另一个的字段权限，也不能从一个还原另一个（PR #115 第 3 轮 R2-3）。
 */
const LINKED_FIELDS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  [IDP_OBJECTS.templateModule.code]: [['keyInfoSources', 'keyInfoBlocks']],
};

/** 写入要校验的字段：载荷里出现联动组的任一字段，整组都要可编辑。 */
export function withLinkedFields(objectCode: string, fields: readonly string[]): string[] {
  const expanded = new Set(fields);
  for (const group of LINKED_FIELDS[objectCode] ?? []) {
    if (group.some((field) => expanded.has(field))) for (const field of group) expanded.add(field);
  }
  return [...expanded];
}

/** 可见字段：联动组有任一字段看不到，整组都不输出（undefined = 全部可见）。 */
export function linkedViewable<T extends ReadonlySet<string> | undefined>(objectCode: string, fields: T): T {
  if (fields === undefined) return fields;
  const groups = LINKED_FIELDS[objectCode] ?? [];
  const broken = groups.filter((group) => !group.every((field) => fields.has(field)));
  if (!broken.length) return fields;
  const hidden = new Set(broken.flat());
  return new Set([...fields].filter((field) => !hidden.has(field))) as ReadonlySet<string> as T;
}

/** 说明文本依据的字段（DEC-309④：与 fixedDate 同一门禁；看不到其中任一个就不输出说明文本）。 */
export const RULE_TEXT_SOURCES = [
  'startMode',
  'startTimeType',
  'fixedDate',
  'referencePoint',
  'startFrom',
  'days',
] as const satisfies readonly (typeof SUB_PROCESS_FIELDS)[number][];
