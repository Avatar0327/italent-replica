/** F-058 合成头像夹具：所有头像均经本人登记和上传入口创建。 */
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import type { World360 } from './AC-360-support.js';
import { imageFixture } from './AC-TC-model-image-support.js';

export interface AvatarReference {
  id: string;
  url: string;
}

export async function avatarEmployee(w: World360, name: string, orgId: string, managerId?: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
  return employee;
}

export async function employeeAvatar(w: World360, employeeId: string) {
  const result = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE employee_id=${employeeId}::uuid`),
  );
  const links = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { user_id: string }[];
  expect(links).toHaveLength(1);
  const user = links[0]!.user_id;
  const base = '/api/tenant/account/avatar';
  const request = (method: string, path = '', extra: Parameters<World360['api']['request']>[2] = {}) =>
    w.api.request(method, `${base}${path}`, { ...extra, user, tenant: w.tenantId });
  const current = await w.ok<{ revision: number }>(request('GET'));
  const fixture = imageFixture();
  const registered = await w.ok<{ revision: number; attachment: { id: string } }>(
    request('POST', '/attachments', { ifMatch: current.revision, body: fixture.metadata }),
    201,
  );
  const uploaded = await w.ok<{ revision: number; avatar: AvatarReference }>(
    request('POST', `/attachments/${registered.attachment.id}/upload`, {
      ifMatch: registered.revision,
      body: { base64: fixture.base64 },
    }),
  );
  return { ...uploaded, user, request, fixture };
}
