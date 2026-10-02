import type { Tx } from '@italent/db';

/** Permission owns this port; business modules supply readers without permission importing their implementation. */
export interface ScopeBusinessContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly expectedRevision: number;
  readonly now: Date;
  readonly commandId: string;
}

export type ScopedJobKind =
  'layers' | 'grades' | 'level-types' | 'levels' | 'sequences' | 'professional-lines' | 'posts' | 'positions';

export interface ScopedJobObject {
  readonly id: string;
  readonly revision: number;
  readonly orgId?: string | null;
}

export interface JobScopeReader {
  load(
    tx: Tx,
    tenantId: string,
    kind: ScopedJobKind,
    id: string,
    asOf: string,
    includeDisabled: boolean,
  ): Promise<ScopedJobObject | undefined>;
  latest(tx: Tx, tenantId: string, kind: ScopedJobKind, id: string): Promise<ScopedJobObject | undefined>;
}

let jobReader: JobScopeReader | undefined;
export function registerJobScopeReader(reader: JobScopeReader): void {
  jobReader = reader;
}
export function jobScopeReader(): JobScopeReader {
  if (!jobReader) throw new Error('JobScopeReader is not registered');
  return jobReader;
}
