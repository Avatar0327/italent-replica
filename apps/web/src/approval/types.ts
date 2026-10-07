export type ApprovalTab = 'todos' | 'processed' | 'initiated';
export type ApprovalAction =
  | 'approve'
  | 'disagree'
  | 'reject'
  | 'transfer'
  | 'addSign'
  | 'cc'
  | 'edit'
  | 'retrieve'
  | 'withdraw'
  | 'urge'
  | 'resubmit'
  | 'adminTransfer'
  | 'adminIntervene';

export interface ApprovalListItem {
  readonly id?: string;
  readonly instanceId?: string;
  readonly taskId?: string;
  readonly title: string;
  readonly status?: string;
  readonly approvalType?: string;
  readonly nodeName?: string;
  readonly currentNodeKey?: string | null;
  readonly createdAt?: string | null;
}
export interface ApprovalTask {
  readonly id: string;
  readonly nodeKey?: string;
  readonly nodeName?: string;
  readonly status: string;
  readonly origin?: string;
  readonly assigneeUserId?: string | null;
  readonly isExceptionAdmin?: boolean;
  readonly adminSelfTransfer?: boolean;
  readonly comment?: string | null;
  readonly actedAt?: string | null;
}
export interface ApprovalLog {
  readonly id?: string;
  readonly seq?: number;
  readonly event: string;
  readonly nodeKey?: string | null;
  readonly actorUserId?: string | null;
  readonly adminSelfTransfer?: boolean;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt?: string | null;
}
export interface ApprovalDetail {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly approvalType?: string;
  readonly revision: number;
  readonly currentNodeKey: string | null;
  readonly round?: number;
  readonly taskId: string | null;
  readonly retrieveTaskId: string | null;
  readonly createdAt?: string | null;
  readonly completedAt?: string | null;
  readonly tasks: readonly ApprovalTask[];
  readonly logs: readonly ApprovalLog[];
  readonly recordsHidden: boolean;
  readonly commentNotice: string;
  readonly form: {
    readonly values: Readonly<Record<string, unknown>>;
    readonly originals?: Readonly<Record<string, unknown>>;
    readonly editMode: 'none' | 'separate' | 'with_approve';
    readonly editableFields: readonly string[];
  };
  readonly actions: readonly string[];
}
export interface ApprovalPageResult<T> {
  readonly items: readonly T[];
  readonly page?: number;
  readonly pageSize?: number;
  readonly recordsHidden?: boolean;
}
export interface ActionDraft {
  readonly comment: string;
  readonly toUserId: string;
  readonly userIds: string;
  readonly signType: 'before' | 'after' | 'parallel';
  readonly taskId: string;
  readonly adminKind: 'reassign' | 'jump';
  readonly nodeKey: string;
  readonly reason: string;
}
export type FieldDraft = Readonly<Record<string, { readonly path: readonly string[]; readonly value: unknown }>>;
export interface ApprovalCommand {
  readonly id: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}
