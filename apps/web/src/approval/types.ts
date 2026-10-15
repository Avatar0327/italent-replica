import type { PageResult } from '../foundation/client.js';

export type ApprovalView = 'pending' | 'completed' | 'initiated';
export type ApprovalAction = 'approve' | 'disagree' | 'reject' | 'transfer' | 'withdraw';
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
  form: { values: Record<string, unknown>; originals?: Record<string, unknown> };
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
}
export interface ApprovalLog {
  event: string;
  nodeKey?: string | null;
  taskId?: string | null;
  actorUserId?: string | null;
  /** 事件自身的明细；意见在 detail.comment（后端 appendLog）。 */
  detail?: Record<string, unknown>;
  createdAt: string;
}
export interface ApprovalList extends PageResult<ApprovalRow> {
  demo?: boolean;
}
