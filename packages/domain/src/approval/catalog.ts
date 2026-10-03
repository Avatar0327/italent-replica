/**
 * 审批中心的权限对象目录（DEC-080：真实字段与按钮）。
 * 审批人的同意 / 驳回 / 转交 / 加签 / 编辑 由“被分配任务 + 节点动作开关”决定，不是身份按钮（`14` §8.2）；
 * 流程配置与管理员转交 / 干预才受身份对象权限控制（DEC-063 / DEC-070）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const APPROVAL_PROCESS_OBJECT = 'TenantBase.ApprovalProcess';
export const APPROVAL_INSTANCE_OBJECT = 'TenantBase.ApprovalInstance';

const field = (code: string, system = false) => ({ code, system });
const button = (code: string, level: ButtonDefinition['level'], requires?: ButtonDefinition['requires']) =>
  requires ? { code, level, requires } : { code, level };

export const APPROVAL_OBJECTS: readonly ObjectDefinition[] = [
  {
    code: APPROVAL_PROCESS_OBJECT,
    application: 'TenantBase',
    fields: [
      ...[
        'code',
        'name',
        'approvalType',
        'groupName',
        'description',
        'priority',
        'isFallback',
        'exceptionAdminUserId',
        'urgeEnabled',
        'conditions',
        'nodes',
      ].map((code) => field(code)),
      ...[
        'id',
        'objectCode',
        'status',
        'presetKey',
        'revision',
        'currentVersion',
        'latestVersion',
        'versionNo',
        'createdAt',
        'createdBy',
        'publishedAt',
        'publishedBy',
      ].map((code) => field(code, true)),
    ],
    buttons: [
      button('create', 'list', 'create'),
      button('installPresets', 'list', 'create'),
      button('simulateByObject', 'list'),
      button('update', 'detail', 'update'),
      button('newVersion', 'detail', 'update'),
      button('publish', 'detail', 'update'),
      button('discard', 'detail', 'update'),
      button('simulate', 'detail'),
    ],
  },
  {
    code: APPROVAL_INSTANCE_OBJECT,
    application: 'TenantBase',
    fields: [
      'id',
      'title',
      'status',
      'approvalType',
      'processId',
      'processCode',
      'versionNo',
      'businessId',
      'currentNodeKey',
      'round',
      'initiatorUserId',
      'subjectEmployeeId',
      'tasks',
      'logs',
      'form',
      'actions',
      'revision',
      'createdAt',
      'completedAt',
    ].map((code) => field(code, true)),
    buttons: [button('adminLogs', 'list'), button('adminTransfer', 'detail'), button('adminIntervene', 'detail')],
  },
];
