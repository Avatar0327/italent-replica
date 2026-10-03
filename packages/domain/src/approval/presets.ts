/**
 * 出厂预置流程（DEC-018）：按本租户调动流程的节点结构（`14` §2、§8.2、§8.3）预置，并出厂带发起条件；
 * 异常管理员只能由租户指定，故预置为草稿，配置异常管理员后才能发布（DEC-054）。
 */
import type { ApprovalNode, ApprovalTypeCode, ProcessDefinition } from './types.js';

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
    actions: { transfer: false, addSign: false, urge: true },
    rejectCommentRequired: false,
    rejectResubmit: 'restart',
    messageRules: [],
    ...extra,
  }) satisfies ApprovalNode;

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
          actions: { transfer: true, addSign: true, urge: true },
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
];
