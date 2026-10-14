/** AC-QL-presets 的夹具：租户管理员把某个标准身份授给一名新成员，返回该成员的调用身份。 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import type { World } from './f061.js';
import { cmd } from './tenant-api.js';

export async function holderOfProfile(
  w: Pick<World, 'db' | 'api' | 'asAdmin' | 'profileIds'>,
  profileCode: string,
  label: string,
): Promise<{ user: string; tenant: string }> {
  const user = await createUser(w.db, { email: `${label}-${randomUUID()}@example.com`, displayName: label }, cmd());
  await grantMembership(w.db, { tenantId: w.asAdmin.tenant, userId: user.id, expectedRevision: 0 }, cmd());
  const granted = await w.api.request('POST', '/api/tenant/permission/grants', {
    ...w.asAdmin,
    body: { userId: user.id, profileId: w.profileIds.get(profileCode) },
  });
  if (granted.status !== 201) throw new Error(`授予 ${profileCode} 失败：${granted.status} ${await granted.text()}`);
  return { user: user.id, tenant: w.asAdmin.tenant };
}
