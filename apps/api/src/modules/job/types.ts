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
  readonly [field: string]: unknown;
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
