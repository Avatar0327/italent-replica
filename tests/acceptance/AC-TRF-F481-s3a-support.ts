/** S3a 只经本片 HTTP 与已合入 S1/S2 建立签署场景。 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { applySignEvent, type SignTask } from '../../apps/api/src/modules/esign/sign-events.js';
import { userOfPerson } from '../../apps/api/src/modules/approval/resolver.js';
import { signWorld, SIGN_AT, rows } from './AC-TRF-F481-s2-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';

export const BASE = '/api/tenant/esign';
export const REISSUE = 'MulLaunchESignTranfer';
export const EMPLOYMENT = 'TenantBase.EmploymentRecord';
export interface Receipt {
  id: string;
  ok: boolean;
  code?: string;
  taskId?: string;
  status?: string;
  failureReason?: string | null;
}
export async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}
export async function reason(response: Response, code: string, status = 409) {
  const body = await json<{ error: { code: string; details?: { reason?: string } } }>(response, status);
  expect(body.error.details?.reason ?? body.error.code).toBe(code);
}
export async function mineWorld(db: Db, label: string) {
  const w = await signWorld(db, `s3a-${label}`);
  let now = new Date(SIGN_AT);
  const api = tenantApi(db, { clock: () => now });
  const employeeUser = await withTenant(db, w.tenantId, (tx) => userOfPerson(tx, w.tenantId, w.person.employee.id));
  expect(employeeUser).toBeTruthy();
  const outsider = await createUser(
    db,
    { email: `syn-${randomUUID()}@example.com`, displayName: 'ZZ_F481_OTHER' },
    cmd(),
  );
  await grantMembership(db, { tenantId: w.tenantId, userId: outsider.id, expectedRevision: 0 }, cmd());
  const request = (user: string, method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path.startsWith('/api/') ? path : `${BASE}${path}`, {
      ...options,
      user,
      tenant: w.tenantId,
    });
  const hr = (method: string, path: string, options: RequestOptions = {}) =>
    request(w.session.user.id, method, path, options);
  const employee = (method: string, path: string, options: RequestOptions = {}) =>
    request(employeeUser!, method, path, options);
  const sign = (user: string, task: { id: string; revision: number }, key = randomUUID()) =>
    request(user, 'POST', `/mine/${task.id}/sign`, { body: { revision: task.revision }, idempotencyKey: key });
  const reissue = (ids: string[], options: RequestOptions = {}) =>
    hr('POST', '/transfer-tasks', {
      body: { items: ids.map((businessId) => ({ businessId })), templateIds: [w.templates[2]!.id] },
      ...options,
    });
  const restricted = (authorize: Authorizer) => {
    const api = tenantApi(db, { authorize, clock: () => now });
    return (method: string, path: string, options: RequestOptions = {}) =>
      api.request(method, path, {
        ...options,
        user: w.session.user.id,
        tenant: w.tenantId,
      });
  };
  const ctx = () => ({
    tenantId: w.tenantId,
    tenantName: w.session.tenant.name,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now,
    expectedRevision: 0,
    commandId: randomUUID(),
  });
  const revoke = (task: SignTask) =>
    withTenant(db, w.tenantId, (tx) =>
      applySignEvent(tx, ctx(), task, {
        type: 'revoked',
        cause: 'manual',
        actorUserId: w.session.user.id,
        at: now,
      }),
    );
  const audits = (id: string) =>
    withTenant(db, w.tenantId, async (tx) =>
      rows<{ action: string; after: unknown }>(
        await tx.execute(sql`SELECT action,after FROM audit_events WHERE tenant_id=${w.tenantId} AND object_id=${id}
      AND action LIKE 'esign.task.%' ORDER BY action`),
      ),
    );
  return {
    ...w,
    hr,
    employee,
    request,
    employeeUser: employeeUser!,
    outsider,
    sign,
    reissue,
    restricted,
    revoke,
    audits,
    setNow: (at: string) => {
      now = new Date(at);
      w.session.setNow(at);
    },
    ctx,
  };
}
