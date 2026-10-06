import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect } from 'vitest';
import { createProfile, makeGrantable, setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import { scenario, now } from './AC-JOB-sequence-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
const testDb = useTestDb();
export async function fixture() {
  const { db } = testDb();
  const s = await scenario(db);
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: s.world.tenant.id, userId: s.world.user.id }, cmd());
  const world: PermissionWorld = {
    db,
    tenant: s.world.tenant,
    admin: s.world.user,
    adminRecord,
    api: tenantApi(db, { authorize: undefined, clock: () => now }),
    asAdmin: { tenant: s.world.tenant.id, user: s.world.user.id },
  };
  return { ...s, db, permissions: world };
}
export async function profile(world: PermissionWorld, button = true) {
  const profile = await createProfile(world, `sync-${randomUUID()}`);
  for (const definition of [MODULE_OBJECTS.jobPost, MODULE_OBJECTS.employmentRecord]) {
    const result = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
        buttons: definition === MODULE_OBJECTS.jobPost && button ? [{ buttonCode: 'syncSequence', level: 'list' }] : [],
      },
      definition.code,
    );
    expect(result.status, await result.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  return profile;
}
