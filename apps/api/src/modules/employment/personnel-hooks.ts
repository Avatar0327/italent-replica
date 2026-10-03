import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { EmploymentContext } from './types.js';

export interface PersonnelHooks {
  currentName(tenantId: string, employee: SQL, originalName: SQL): SQL;
  sync(
    tx: Tx,
    ctx: EmploymentContext,
    employeeId: string,
    recordId: string,
    kind: string,
    effectiveDate: string,
    deleted?: boolean,
  ): Promise<void>;
}

let hooks: PersonnelHooks = {
  currentName: (_tenantId, _employee, originalName) => sql`${originalName}`,
  sync: async () => undefined,
};

/** Employment owns this port; personnel supplies the optional projection at application assembly time. */
export function registerPersonnelHooks(implementation: PersonnelHooks): void {
  hooks = implementation;
}

export const personnelHooks: PersonnelHooks = {
  currentName: (...args) => hooks.currentName(...args),
  sync: (...args) => hooks.sync(...args),
};
