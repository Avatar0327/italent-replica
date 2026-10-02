import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import type { EmploymentBusinessInput } from '../../apps/api/src/modules/employment/types.js';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

export async function forwardFixture(db: Db, label: string) {
  const session = await employmentSession(db, label);
  const employee = await session.employee('向后更新合成员工');
  const org = await session.org('原部门', { startDate: '2026-01-01' });
  const nextOrg = await session.org('新部门', { startDate: '2026-01-01' });
  const hired = await session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { employType: 'internal', departmentId: org.id, place: '原地点' },
    },
    employee.revision,
  );
  return { session, employee, org, nextOrg, hired };
}

export interface ForwardPreview {
  readonly employeeRevision: number;
  readonly changes: readonly {
    readonly businessId: string;
    readonly staffId: string;
    readonly status: string;
    readonly fields: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
  }[];
}

export async function preview(session: EmploymentSession, employeeId: string, business: EmploymentBusinessInput) {
  const response = await session.request('POST', `/employees/${employeeId}/forward-update-preview`, {
    body: business,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ForwardPreview;
}

export function forwardJobApi(db: Db, session: EmploymentSession) {
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00.000Z') });
  return {
    async create(kind: string, extra: Record<string, unknown> = {}) {
      const response = await api.request('POST', `/api/tenant/job/${kind}`, {
        user: session.user.id,
        tenant: session.tenant.id,
        ifMatch: 0,
        body: {
          name: `合成${kind}-${randomUUID()}`,
          code: `FWD_${randomUUID().replaceAll('-', '')}`,
          startDate: '2026-01-01',
          ...extra,
        },
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string; revision: number };
    },
  };
}
