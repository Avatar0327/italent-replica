/**
 * AC-PRM-23（06 §7.2）：系统字段（创建人 / 修改时间等）的「编辑」不可勾选。
 * 复刻：配置身份对象权限时后端拒绝给系统字段授「编辑」（机器可读原因 SYSTEM_FIELD_NOT_EDITABLE），「查看」可以授。
 * 同时覆盖身份配置的平台约定：If-Match 必填、旧 revision → 409、未知字段 / 按钮 / 对象被拒、变更写审计。
 */
import { auditEvents, eq, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  createProfile,
  DEMO_OBJECT,
  type PermissionWorld,
  type ProfileBody,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const NO_OPS = { create: false, update: false, delete: false };

describe('AC-PRM-23 系统字段的编辑不可授', () => {
  let world: PermissionWorld;
  let profile: ProfileBody;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    profile = await createProfile(world, 'cfg');
  });

  it('给系统字段 CreatedBy 授编辑 → 400，details 指明原因；只授查看 → 200', async () => {
    const before = profile.revision;
    const denied = await setObjectPermission(world, profile, {
      dataOperations: NO_OPS,
      fields: [{ fieldCode: 'CreatedBy', view: true, edit: true }],
      buttons: [],
    });
    expect(denied.status).toBe(400);
    const body = (await denied.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toEqual([{ reason: 'SYSTEM_FIELD_NOT_EDITABLE', fieldCode: 'CreatedBy' }]);
    expect(profile.revision).toBe(before);

    const ok = await setObjectPermission(world, profile, {
      dataOperations: NO_OPS,
      fields: [{ fieldCode: 'CreatedBy', view: true, edit: false }],
      buttons: [],
    });
    expect(ok.status).toBe(200);
    expect(profile.revision).toBe(before + 1);

    const detail = await world.api.request('GET', `${BASE}/profiles/${profile.id}`, world.asAdmin);
    expect(detail.headers.get('etag')).toBe(`"${profile.revision}"`);
    expect(await detail.json()).toMatchObject({
      objects: [{ objectCode: DEMO_OBJECT.code, fields: [{ fieldCode: 'CreatedBy', view: true, edit: false }] }],
    });
  });

  it('未知字段 / 按钮 / 对象被拒；缺 If-Match → 400；旧 revision → 409；成功的配置写审计', async () => {
    const unknown = await setObjectPermission(world, profile, {
      dataOperations: NO_OPS,
      fields: [{ fieldCode: 'Nope', view: true, edit: false }],
      buttons: [{ buttonCode: 'Nope', level: 'list' }],
    });
    expect(unknown.status).toBe(400);
    const noObject = await setObjectPermission(
      world,
      profile,
      { dataOperations: NO_OPS, fields: [], buttons: [] },
      'X.Y',
    );
    expect(noObject.status).toBe(404);

    const path = `${BASE}/profiles/${profile.id}/objects/${DEMO_OBJECT.code}`;
    const body = { dataOperations: NO_OPS, fields: [], buttons: [] };
    const noIfMatch = await world.api.request('PUT', path, { ...world.asAdmin, body });
    expect(await errorCode(noIfMatch)).toBe('REVISION_REQUIRED');
    const stale = await world.api.request('PUT', path, { ...world.asAdmin, ifMatch: profile.revision - 1, body });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');

    const events = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectId, profile.id)),
    );
    expect(events.map((e) => e.action).sort()).toEqual(['permission_profile.create', 'permission_profile.set_object']);
  });
});
