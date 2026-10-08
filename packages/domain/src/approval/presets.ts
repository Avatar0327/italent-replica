import { CONTRACT_FIELDS } from '../contracts/rules.js';
/**
 * 出厂预置流程（DEC-018 / DEC-094 / DEC-116）：全部审批类型都有草稿预置，租户开通时配置异常管理员后发布（R1-T17）。
 * 有标准流程编码的类型都带“流程编码 = 标准编码”发起条件（`14` §11.1）。调动按本租户已取证的节点结构（`14` §2、§8.2、
 * §8.3，开关按 §11.10 更正）与 TransferDetailView 已交付字段（§11.2，DEC-118）预置；离职按 §8.5 取证的
 * “直接上级 → HR 访谈”结构，直接上级取最新生效主职任职的直线经理（DEC-230）；
 * 其余类型的节点结构尚未取证（TODO(需取证 #38)），预置为
 * “部门负责人审批 → HRBP 审核”，由租户调整后发布。
 */
import { TRANSFER_FORM_FIELDS } from './transfer-view.js';
import {
  APPROVAL_TYPES,
  type ApprovalTypeCode,
  type ApproverExpression,
  type ProcessDefinition,
  type SingleApprovalNode,
} from './types.js';

export interface PresetProcess {
  readonly presetKey: string;
  readonly code: string;
  readonly approvalType: ApprovalTypeCode;
  readonly definition: ProcessDefinition;
}

/**
 * 相同 / 历史相同审批人自动处理默认关闭：本租户调动流程各节点都未启用（`14` §11.10 更正 §8.3，登记册 C-008），
 * 功能仍可由管理员按节点开启。
 */
const node = (key: string, name: string, approver: ApproverExpression, extra: Partial<SingleApprovalNode> = {}) =>
  ({
    key,
    name,
    approver,
    noAssignee: 'exception_admin',
    sameAssigneeSkip: false,
    historySameAssigneeSkip: false,
    sameAssigneeResult: 'approve',
    historySameAssigneeResult: 'approve',
    formFields: TRANSFER_FORM_FIELDS,
    editableFields: [],
    editMode: 'none',
    actions: { transfer: false, addSign: false, copySend: false, retrieve: false, reject: true, urge: 'inherit' },
    rejectCommentRequired: false,
    hideRecords: false,
    rejectResubmit: 'restart',
    messageRules: [],
    ...extra,
  }) satisfies SingleApprovalNode;

/** IDP 预置节点的开关（DEC-318 K-37，原站 MakePlan 节点原值）。 */
const IDP_ACTIONS = {
  transfer: false,
  addSign: false,
  copySend: false,
  retrieve: false,
  reject: true,
  urge: 'inherit',
  avoidSelf: false,
} as const;

type DraftInput = Omit<
  ProcessDefinition,
  'exceptionAdminUserId' | 'urgeEnabled' | 'groupName' | 'hideRecordsFromInitiator'
>;
const draft = (definition: DraftInput): ProcessDefinition => ({
  groupName: '员工审批流程',
  exceptionAdminUserId: null,
  urgeEnabled: true,
  hideRecordsFromInitiator: false,
  ...definition,
});

/** “流程编码 = 本类型标准编码”发起条件；没有标准编码的类型预置为本类型兜底流程（DEC-018）。 */
function standardCondition(type: ApprovalTypeCode): Pick<ProcessDefinition, 'conditions' | 'isFallback'> {
  const code = APPROVAL_TYPES[type].defaultProcessCode;
  if (!code) return { isFallback: true, conditions: { items: [], expression: '' } };
  return {
    isFallback: false,
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: code }], expression: '1' },
  };
}

/** 未取证节点结构的任职类审批：部门负责人审批 → HRBP 审核（TODO(需取证 #38)）。 */
const GENERIC_FORM = ['effectiveDate', 'departmentId', 'postId', 'positionId', 'levelId'];
type GenericType = Exclude<ApprovalTypeCode, 'transfer' | 'leave' | 'personnel_change' | 'emp_info_change'>;
function genericPreset(type: GenericType): PresetProcess {
  const name = APPROVAL_TYPES[type].name;
  const form = type.startsWith('contract_') ? CONTRACT_FIELDS : GENERIC_FORM;
  return {
    presetKey: `standard_${type}`,
    code: `Standard_${type}`,
    approvalType: type,
    definition: draft({
      name: `标准${name}流程`,
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition(type),
      nodes: [
        node('department_head', '部门负责人审批', 'latest_record_department_head', { formFields: form }),
        node('hrbp', 'HRBP审核', 'record_department_hrbp', { formFields: form }),
      ],
    }),
  };
}

const LEAVE_FORM = ['lastWorkDate', 'effectiveDate', 'departmentId', 'postId'];

export const PRESET_PROCESSES: readonly PresetProcess[] = [
  {
    presetKey: 'standard_transfer',
    code: 'StandardTransfer',
    approvalType: 'transfer',
    definition: {
      name: '标准调动流程',
      groupName: '员工审批流程',
      description: '出厂预置：按本租户调动流程节点结构建立，发布前须配置异常管理员',
      priority: 0,
      isFallback: false,
      exceptionAdminUserId: null,
      urgeEnabled: true,
      hideRecordsFromInitiator: false,
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }],
        expression: '1',
      },
      nodes: [
        node('out_head', '调出部门负责人审批', 'latest_record_department_head'),
        node('in_hrbp', '调入部门HRBP审核', 'record_department_hrbp', {
          actions: { transfer: true, addSign: true, copySend: true, retrieve: true, reject: true, urge: 'inherit' },
          rejectResubmit: 'rejecting_node',
          messageRules: [
            {
              trigger: 'approve',
              channels: ['inbox', 'email'],
              template: 'TenantBase.Ygddtz',
              recipient: 'subject_employee',
            },
          ],
        }),
        node('in_head', '调入部门负责人审批', 'record_department_head'),
        node('first_level', '单人审批', 'record_first_level_org_head'),
      ],
    },
  },
  {
    presetKey: 'standard_leave',
    code: 'StandardDimission',
    approvalType: 'leave',
    definition: draft({
      name: '标准离职流程',
      description: '出厂预置：直接上级（最新生效主职任职的直线经理） → HR访谈，发布前须配置异常管理员',
      priority: 0,
      isFallback: false,
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }],
        expression: '1',
      },
      nodes: [
        node('direct_head', '直接上级', 'direct_manager', { formFields: LEAVE_FORM }),
        node('hr_interview', 'HR访谈', 'record_department_hrbp', { formFields: LEAVE_FORM }),
      ],
    }),
  },
  ...(
    [
      'regularization',
      'intern_regularization',
      'hire',
      'retirement',
      'org_adjustment',
      'add_employee',
      'contract_create',
      'contract_renew',
      'contract_change',
      'contract_terminate',
    ] as const
  ).map(genericPreset),
  {
    // DEC-116：个人信息变更的发起入口未接入；节点结构未取证（TODO(需取证 #38)），表单待租户按需勾选员工信息字段。
    presetKey: 'standard_emp_info_change',
    code: 'StandardEmpInfoChange',
    approvalType: 'emp_info_change',
    definition: draft({
      name: '标准个人信息变更流程',
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition('emp_info_change'),
      nodes: [node('department_head', '部门负责人审批', 'latest_record_department_head', { formFields: [] })],
    }),
  },
  // IDP-R1：预置三条子流程审批流程（制定计划 / 中期回顾 / 期末回顾），节点照原站 W-114 节点链：
  // 发展计划 - 员工本人 → 发展计划 - 指导人（K-09）。
  ...(
    [
      ['idp_plan', 'StandardIdpPlan', '标准制定计划流程', 'set_goals', '制定发展目标', 'approve_plan', '审批发展计划'],
      [
        'idp_mid_review',
        'StandardIdpMidReview',
        '标准中期回顾流程',
        'employee_mid',
        '员工中期回顾',
        'tutor_mid',
        '指导人中期回顾',
      ],
      [
        'idp_final_review',
        'StandardIdpFinalReview',
        '标准期末回顾流程',
        'employee_final',
        '员工期末回顾',
        'tutor_final',
        '指导人期末回顾',
      ],
    ] as const
  ).map(([approvalType, code, name, employeeKey, employeeName, tutorKey, tutorName]): PresetProcess => ({
    presetKey: `standard_${approvalType}`,
    code,
    approvalType,
    definition: draft({
      name,
      description: '出厂预置：员工 → 指导人两个节点，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition(approvalType),
      nodes: [
        // DEC-318：处理人为空照原站“无操作”（K-38）；回避、加签、转交、抄送全部关闭（K-37）
        node(employeeKey, employeeName, 'idp_employee', { formFields: [], noAssignee: 'none', actions: IDP_ACTIONS }),
        node(tutorKey, tutorName, 'idp_tutor', { formFields: [], noAssignee: 'none', actions: IDP_ACTIONS }),
      ],
    }),
  })),
  {
    presetKey: 'standard_personnel_change',
    code: 'StandardPersonnelChange',
    approvalType: 'personnel_change',
    definition: draft({
      name: '标准员工信息变更流程',
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      isFallback: true,
      conditions: { items: [], expression: '' },
      nodes: [node('department_head', '部门负责人审批', 'latest_record_department_head', { formFields: [] })],
    }),
  },
];
