import { and, eq, esignTasks, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { userOfPerson } from '../../apps/api/src/modules/approval/resolver.js';
import { provisionEmployeeUser } from '../../apps/api/src/modules/permission/user-provisioning.js';
import { EMPLOYEE_OBJECT, EMPLOYMENT_OBJECT } from '../../apps/api/src/modules/employment/context.js';
import { RECORD_OBJECT } from '../../apps/api/src/modules/esign/record-access.js';
import { employmentSession, loginEmailOf } from './AC-EMP-support.js';
import { hireBody, portContext } from './AC-EN-BE2a-support.js';
import { controlledApi, type ControlledGrants } from './AC-LNK-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export { EMPLOYEE_OBJECT, EMPLOYMENT_OBJECT, RECORD_OBJECT };
export const BASE = '/api/tenant/employment/pending-entries';
export const ESIGN = '/api/tenant/esign';
export const NOW = '2026-10-10T01:00:00.000Z';
export const source = (id: string, view: 'context' | 'tasks' | 'records') => `${BASE}/${id}/esign-${view}`;
export const resultPath = (key: string) => `/api/tenant/commands/${key}/result`;
export type Receipt = { sourceId: string; taskId: string };
export type Entry = { id: string; revision: number };

export async function s5World(db: Db) {
  const session = await employmentSession(db, 'ZZ_F505_S5');
  session.setNow(NOW);
  const org = await session.org('ZZ_F505_S5_入职部门', { establishedOn: '2026-01-01' });
  const w = { db, session, org };
  const { tenant, user } = session;
  const api = tenantApi(db, { clock: () => new Date(NOW) });
  const as = { tenant: tenant.id, user: user.id };
  const call = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path, { ...as, ...options });
  const restricted = (grants: ControlledGrants) => controlledApi(db, tenant.id, user.id, grants, NOW);
  const pending = async (kind: 'hire' | 'rehire' | 'retire_rehire' = 'hire') => {
    const employee = await w.session.employee('ZZ_F505_待入职姓名', `ZZ_F505_${uniqueSuffix()}`);
    let revision = employee.revision;
    if (kind !== 'hire') {
      const hired = await w.session.business(employee.id, hireBody(w.org.id, '2026-01-05'), revision);
      const ended = await w.session.business(
        employee.id,
        { kind: kind === 'rehire' ? 'leave' : 'retirement', mode: 'direct', lastWorkDate: '2026-03-31', fields: {} },
        hired.employeeRevision,
      );
      revision = ended.employeeRevision;
    }
    const entry = await w.session.business(
      employee.id,
      hireBody(w.org.id, '2026-12-01', { kind, pendingEntry: true, formId: 'campus-hire' }),
      revision,
    );
    // 待入职本人使用已有绑定，签署入口本身不建账号。
    const employeeUser = await withTenant(db, tenant.id, async (tx) => {
      const existing = await userOfPerson(tx, tenant.id, employee.id);
      if (existing || kind !== 'hire') return existing;
      await provisionEmployeeUser(tx, portContext(w, 0), {
        employeeId: employee.id,
        loginEmail: loginEmailOf(employee.id),
        displayName: employee.name,
        accountRequired: true,
      });
      return (await userOfPerson(tx, tenant.id, employee.id))!;
    });
    return { ...entry, employee, employeeUser };
  };
  const template = async (body = 'ZZ_F505_静态正文', name = 'ZZ_F505_模板') =>
    json<{ id: string; name: string; revision: number }>(
      await call('POST', `${ESIGN}/templates`, { body: { code: uniqueSuffix(), name, body } }),
      201,
    );
  const submit = (entry: Entry, templateIds: string[], key = uniqueSuffix(), grants?: ControlledGrants) => {
    const path = source(entry.id, 'tasks');
    const body = { templateIds };
    return grants
      ? restricted(grants)('POST', path, { ifMatch: entry.revision, body, key })
      : call('POST', path, { ifMatch: entry.revision, body, idempotencyKey: key });
  };
  const tasks = (entry: Entry) =>
    withTenant(db, tenant.id, (tx) =>
      tx
        .select()
        .from(esignTasks)
        .where(and(eq(esignTasks.tenantId, tenant.id), eq(esignTasks.businessId, entry.id))),
    );
  const error = async (response: Response, status: number, code?: string) => {
    expect(response.status, await response.clone().text()).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: code ?? expect.any(String), message: expect.any(String) } });
    return body;
  };
  return { ...w, api, as, call, restricted, pending, template, submit, tasks, error };
}
