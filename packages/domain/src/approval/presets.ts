/**
 * 出厂预置流程（DEC-018 / DEC-094）：全部业务类型与员工信息变更都有草稿预置，租户开通时配置异常管理员后发布（R1-T17）。
 * 调动按本租户已取证的节点结构（`14` §2、§8.2、§8.3）预置并带流程编码条件；离职按 §8.5 取证的“直接上级 → HR 访谈”
 * 结构以现有表达式近似，并带标准离职流程编码条件；其余类型的节点结构尚未取证，预置为本类型兜底草稿
 * （TODO(需取证 Q-M0-49)），由租户按实际流程调整后发布。
 */
import { APPROVAL_TYPES, type ApprovalNode, type ApprovalTypeCode, type ProcessDefinition } from './types.js';

export interface PresetProcess {
  readonly presetKey: string;
  readonly code: string;
  readonly approvalType: ApprovalTypeCode;
  readonly definition: ProcessDefinition;
}

// TODO(需取证 Q-M0-39)：各节点审批详情页视图（TransferDetailView 等）的确切字段；暂取调动表单“任职调整”区块（`13` §7）。
const TRANSFER_FORM = [
  'effectiveDate',
  'departmentId',
  'postId',
  'levelId',
  'gradeId',
  'sequenceId',
  'positionId',
  'directManagerId',
  'employmentForm',
  'employmentType',
  'isDepartmentHead',
];

const node = (key: string, name: string, approver: ApprovalNode['approver'], extra: Partial<ApprovalNode> = {}) =>
  ({
    key,
    name,
    approver,
    noAssignee: 'exception_admin',
    sameAssigneeSkip: true,
    historySameAssigneeSkip: true,
    formFields: TRANSFER_FORM,
    editableFields: [],
    editMode: 'none',
    actions: { transfer: false, addSign: false, copySend: false, retrieve: false, urge: 'inherit' },
    rejectCommentRequired: false,
    commentPrivate: false,
    rejectResubmit: 'restart',
    messageRules: [],
    ...extra,
  }) satisfies ApprovalNode;

const draft = (definition: Omit<ProcessDefinition, 'exceptionAdminUserId' | 'urgeEnabled' | 'groupName'>) => ({
  groupName: '员工审批流程',
  exceptionAdminUserId: null,
  urgeEnabled: true,
  ...definition,
});

/** 未取证节点结构的业务类型：部门负责人审批 → HRBP 审核（TODO(需取证 Q-M0-49)）。 */
const GENERIC_FORM = ['effectiveDate', 'departmentId', 'postId', 'positionId', 'levelId'];
function genericPreset(type: Exclude<ApprovalTypeCode, 'transfer' | 'leave' | 'personnel_change'>): PresetProcess {
  const name = APPROVAL_TYPES[type].name;
  return {
    presetKey: `standard_${type}`,
    code: `Standard_${type}`,
    approvalType: type,
    definition: draft({
      name: `标准${name}流程`,
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      isFallback: true,
      conditions: { items: [], expression: '' },
      nodes: [
        node('department_head', '部门负责人审批', 'latest_record_department_head', { formFields: GENERIC_FORM }),
        node('hrbp', 'HRBP审核', 'record_department_hrbp', { formFields: GENERIC_FORM }),
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
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }],
        expression: '1',
      },
      nodes: [
        node('out_head', '调出部门负责人审批', 'latest_record_department_head'),
        node('in_hrbp', '调入部门HRBP审核', 'record_department_hrbp', {
          historySameAssigneeSkip: false,
          actions: { transfer: true, addSign: true, copySend: true, retrieve: true, urge: 'inherit' },
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
      description:
        '出厂预置：按本租户离职流程“直接上级 → HR访谈”结构近似（直接上级暂以部门负责人表达），发布前须配置异常管理员',
      priority: 0,
      isFallback: false,
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }],
        expression: '1',
      },
      nodes: [
        node('direct_head', '直接上级审批', 'latest_record_department_head', { formFields: LEAVE_FORM }),
        node('hr_interview', 'HR访谈', 'record_department_hrbp', { formFields: LEAVE_FORM }),
      ],
    }),
  },
  ...(
    [
      'regularization',
      'intern_regularization',
      'hire',
      'rehire',
      'retire_rehire',
      'retirement',
      'org_adjustment',
    ] as const
  ).map(genericPreset),
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
