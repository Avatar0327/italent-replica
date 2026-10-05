import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export interface ContractView {
  id: string;
  revision: number;
  employeeId: string;
  number: string;
  typeId: string;
  effectiveDate: string;
  endDate: string | null;
  status: string;
  approvalStatus: string;
  termType: string;
  signingCount: number;
  previousContractId: string | null;
}

export async function contractWorld(db: Db, label: string) {
  const session = await employmentSession(db, label);
  let now = new Date('2026-10-01T01:00:00Z');
  const api = tenantApi(db, { clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/contracts${path}`, {
      ...options, user: session.user.id, tenant: session.tenant.id,
    });
  const org = await session.org('合同部门', { startDate: '2025-01-01' });
  const employee = await session.employee();
  await session.business(employee.id, {
    kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id },
  }, employee.revision);
  async function master(kind: string, name: string) {
    const response = await request('POST', `/master-data/${kind}`, {
      ifMatch: 0, body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as { id: string; revision: number };
  }
  const type = await master('types', '劳动合同');
  const otherType = await master('types', '劳务合同');
  const company = await master('companies', '合成法人公司');
  const fields = {
    typeId: type.id, companyId: company.id, effectiveDate: '2025-01-01', endDate: '2026-09-30',
    termType: 'fixed', termMonths: 21, signingDate: '2024-12-20',
  };
  async function create(extra: Record<string, unknown> = {}) {
    const response = await request('POST', '/commands', {
      ifMatch: 0, body: { operation: 'create', mode: 'direct', employeeId: employee.id, fields: { ...fields, ...extra } },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as ContractView;
  }
  async function change(contract: ContractView, operation: string, patch: Record<string, unknown>) {
    return request('POST', '/commands', {
      ifMatch: contract.revision,
      body: { operation, mode: 'direct', employeeId: employee.id, targetId: contract.id, fields: patch },
    });
  }
  async function list(view = 'all') {
    const response = await request('GET', `?view=${view}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: ContractView[] }).items;
  }
  async function settings(patch: Record<string, unknown>) {
    const current = await (await request('GET', '/settings')).json() as { revision: number };
    const response = await request('PUT', '/settings', { ifMatch: current.revision, body: patch });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  return { db, session, employee, org, type, otherType, company, fields, request, create, change, list, settings,
    setNow(value: string) { now = new Date(value); },
  };
}
