import type { Tx } from '@italent/db';

export interface JobWriteContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

export interface JobParent {
  readonly parentId: string | null;
  readonly sequence?: number | null;
}

export interface JobInput {
  readonly name: string;
  readonly code?: string;
  readonly startDate?: string;
  readonly stopDate?: string;
  readonly enabled?: boolean;
  readonly establishedOn?: string | null;
  readonly parents?: Partial<Record<'admin' | 'dotted', JobParent>>;
  readonly [field: string]: unknown;
}

export interface JobPatch {
  readonly effectiveDate: string;
  readonly parents?: Partial<Record<'admin' | 'dotted', JobParent>>;
  /** 仅职位：本次变更的「调整员工直线经理」单次选项，不写入职位字段（docs/02_业务建模/19 §3.1）。 */
  readonly adjustEmployeeDirectManager?: boolean;
  readonly [field: string]: unknown;
}

/** 本次职位变更的单次选项，与职位字段分开传递。 */
export interface PositionChangeOptions {
  readonly adjustEmployeeDirectManager: boolean;
}

/**
 * 本次同步跳过的员工及原因，随保存结果返回 `managerSync.skipped`：
 * - EMPLOYEE_IS_SOLE_MANAGER：员工本人就是新上级唯一在岗人（DEC-131）；
 * - OUT_OF_SCOPE：员工的任职不在操作人当前任职数据范围内（PR #54 首审 P2-1），与其他“不同步”分支一样照常保存职位。
 */
export type ManagerSyncSkipReason = 'EMPLOYEE_IS_SOLE_MANAGER' | 'OUT_OF_SCOPE';

export interface ManagerSyncSkip {
  readonly employeeId: string;
  readonly assignmentId: string;
  readonly reason: ManagerSyncSkipReason;
}

/** 新上级职位恰好 1 人在岗、实际执行了同步时才有此结果。 */
export interface ManagerSyncResult {
  readonly skipped: readonly ManagerSyncSkip[];
}

export interface JobIncumbent {
  readonly employeeId: string;
  readonly assignmentId: string;
  readonly revision: number;
  readonly directManagerId: string | null;
}

/** 可信员工模块在传入的租户事务内验权、校验任职 revision，并追加任职版本（实现见 job/employment-port.ts）。 */
export interface JobPersonnelGateway {
  /** limit：调用方只需判断有无 / 是否唯一时传入；不传时读全部，超过单次上限整体拒绝而不是截断。 */
  listIncumbents(
    tx: Tx,
    query: { readonly tenantId: string; readonly positionId: string; readonly asOf: string; readonly limit?: number },
  ): Promise<readonly JobIncumbent[]>;
  appendManagerVersion(
    tx: Tx,
    ctx: JobWriteContext,
    change: {
      readonly assignmentId: string;
      readonly employeeId: string;
      readonly expectedRevision: number;
      readonly effectiveDate: string;
      readonly directManagerId: string | null;
      /** W-416：业务类型“组织调整”。 */
      readonly businessKind: 'org_adjustment';
      /** W-416：变动类型“职位调整”。 */
      readonly changeType: 'position_adjustment';
    },
  ): Promise<ManagerSyncOutcome>;
}

/** 追加结果：员工不在操作人范围内时不写入并返回跳过原因；写入失败一律抛错，由职位变更整单回滚。 */
export type ManagerSyncOutcome = { readonly skipped: 'OUT_OF_SCOPE' } | void;

export interface JobFields extends Record<string, unknown> {
  readonly code: string;
  readonly name: string;
  readonly startDate: string;
  readonly stopDate: string;
  readonly enabled: boolean;
  readonly establishedOn: string | null;
  readonly displayOrder: number | null;
  readonly qualificationId: string | null;
}
