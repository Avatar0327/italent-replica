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

export interface JobIncumbent {
  readonly employeeId: string;
  readonly assignmentId: string;
  readonly revision: number;
  readonly directManagerId: string | null;
}

/** 可信员工模块在传入的租户事务内验权、校验任职 revision，并追加任职版本。 */
export interface JobPersonnelGateway {
  listIncumbents(
    tx: Tx,
    query: { readonly tenantId: string; readonly positionId: string; readonly asOf: string },
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
  ): Promise<void>;
}

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
