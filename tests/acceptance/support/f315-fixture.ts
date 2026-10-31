import type { ProcessView } from '../../../apps/api/src/modules/approval/definitions.js';

export const flowId = 'a1000000-0000-4000-8000-000000000001';
export function flowFixture(): ProcessView {
  return {
    id: flowId,
    code: 'SyntheticTransfer',
    approvalType: 'transfer',
    objectCode: 'TenantBase.EmploymentRecord',
    status: 'active',
    revision: 4,
    presetKey: null,
    currentVersion: null,
    latestVersion: {
      id: 'a2000000-0000-4000-8000-000000000001',
      versionNo: 1,
      status: 'draft',
      publishedAt: null,
      name: '合成调动流程',
      groupName: '员工审批流程',
      description: '合成验收数据',
      priority: 10,
      isFallback: false,
      exceptionAdminUserId: 'a3000000-0000-4000-8000-000000000001',
      urgeEnabled: true,
      hideRecordsFromInitiator: false,
      conditions: { items: [{ no: 1, field: 'business.kind', operator: 'eq', value: 'transfer' }], expression: '1' },
      nodes: ['manager', 'hr'].map((key, index) => ({
        key,
        name: index ? '人事审批' : '上级审批',
        kind: 'single',
        approver: { type: 'object_field', value: 'direct_manager' },
        exits: ['approve'],
        noAssignee: 'exception_admin',
        sameAssigneeSkip: false,
        historySameAssigneeSkip: false,
        sameAssigneeResult: 'approve',
        historySameAssigneeResult: 'approve',
        formFields: ['departmentId'],
        editableFields: [],
        editMode: 'none',
        actions: {
          transfer: true,
          addSign: false,
          copySend: true,
          retrieve: false,
          reject: true,
          urge: 'inherit',
          avoidSelf: true,
          avoidSubjects: false,
        },
        rejectCommentRequired: false,
        hideRecords: false,
        rejectResubmit: 'restart',
        avoidSubjectsResult: 'skip',
        messageRules: [
          { trigger: 'arrive', channels: ['inbox'], template: 'synthetic-template', recipient: 'assignee' },
        ],
      })),
    },
  };
}
export const flowPermission = {
  objectCode: 'TenantBase.ApprovalProcess',
  dataOperations: { read: true, update: true },
  viewableFields: ['code', 'name', 'approvalType', 'nodes', 'conditions', 'description', 'groupName'],
  editableFields: ['nodes'],
  buttons: ['update', 'newVersion'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
};
