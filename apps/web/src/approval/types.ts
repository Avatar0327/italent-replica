import type { PageResult } from '../foundation/client.js';

export type ApprovalView = 'pending' | 'completed' | 'initiated';
export type ApprovalAction = 'approve' | 'reject' | 'transfer' | 'withdraw';
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
  logs: { id?: string; event: string; createdAt: string }[];
}
export interface ApprovalList extends PageResult<ApprovalRow> {
  demo?: boolean;
}
