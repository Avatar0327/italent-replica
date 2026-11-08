import type { PageResult } from '../foundation/client.js';

export type ApprovalView = 'pending' | 'completed' | 'initiated';
export type ApprovalAction = 'approve' | 'disagree' | 'reject' | 'transfer' | 'withdraw' | 'edit';
export interface ApprovalRow {
  id: string;
  title: string;
  status?: string;
  approvalType: string;
  revision?: number;
  taskId?: string;
  nodeName?: string;
  createdAt?: string | null;
}
export interface ApprovalDetail extends ApprovalRow {
  revision: number;
  actions: string[];
  recordsHidden: boolean;
  commentNotice?: string;
  form: {
    values: Record<string, unknown>;
    originals?: Record<string, unknown>;
    /** DEC-655 / F-291：仅当前本人可办理节点下发，字段与必填由服务端裁定。 */
    edit?: {
      taskId: string;
      mode: 'with_approve' | 'separate';
      fields: Array<{ key: string; required: boolean; value: unknown }>;
    };
  };
  tasks: {
    id: string;
    nodeName: string;
    status: string;
    assigneeUserId?: string | null;
    comment?: string | null;
    actedAt?: string | null;
  }[];
  /** 详情只带最近 200 条（升序）；完整分页在 GET /instances/:id/logs。 */
  logs: ApprovalLog[];
  /** F-478 S5：本人当前可办理节点的同意 / 不同意出口（后端 detail-path.ts exitsView）；旧形状没有。 */
  exits?: ApprovalExit[];
  /** F-478 S5：路径条（后端 pathView）；审批记录对本人隐藏时为空数组，旧形状没有。 */
  path?: ApprovalPathStep[];
}
export interface ApprovalExit {
  code: string;
  label: string;
  family: 'approve' | 'disagree';
}
export type ApprovalPathState = 'passed' | 'current' | 'pending' | 'not_on_path';
export interface ApprovalPathStep {
  nodeKey: string;
  name: string;
  state: ApprovalPathState;
  exit?: string;
}
export interface ApprovalLog {
  event: string;
  nodeKey?: string | null;
  taskId?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  /** 事件自身的明细；意见在 detail.comment（后端 appendLog）。 */
  detail?: Record<string, unknown>;
  createdAt: string;
}
export interface ApprovalList extends PageResult<ApprovalRow> {
  demo?: boolean;
}
/** GET /instances?view=applications 的一行（apps/api my-applications.ts）。 */
export interface ApplicationRow extends ApprovalRow {
  approvalTypeName: string;
  initiatorName: string | null;
  currentHandlers: string[];
}
export type ApplicationSort = { field: 'createdAt' | 'status'; order: 'asc' | 'desc' };
