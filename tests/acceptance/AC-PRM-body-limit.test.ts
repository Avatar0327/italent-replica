/**
 * 身份对象权限整对象替换的请求体上限（AGENTS.md §10「请求体默认 32KB，个别接口按需放宽」；Codex 审计 PR #8 第 3 条）：
 * 原站任职记录规模（274 字段、349 按钮）的载荷超过 32KB，该接口放宽到 512KB 仍可配置；超过 512KB → 413；
 * 其他接口仍按默认 32KB。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  createProfile,
  LARGE_OBJECT,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const DEFAULT_LIMIT = 32 * 1024;

describe('身份对象权限：大对象整对象替换可提交，且仍有上限', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  it('274 字段 / 349 按钮的完整配置（> 32KB）→ 200，全部落库', async () => {
    const profile = await createProfile(world, 'large');
    const input = {
      dataOperations: { create: true, update: true, delete: true },
      fields: LARGE_OBJECT.fields.map((f) => ({ fieldCode: f.code, view: true, edit: true })),
      buttons: LARGE_OBJECT.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
    };
    expect(JSON.stringify(input).length).toBeGreaterThan(DEFAULT_LIMIT);
    const res = await setObjectPermission(world, profile, input, LARGE_OBJECT.code);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { objects: { fields: unknown[]; buttons: unknown[] }[] };
    expect(detail.objects[0]!.fields).toHaveLength(274);
    expect(detail.objects[0]!.buttons).toHaveLength(349);
  });

  it('该接口超过 512KB → 413；其他接口超过 32KB 仍 413', async () => {
    const profile = await createProfile(world, 'huge');
    const huge = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/objects/${LARGE_OBJECT.code}`, {
      ...world.asAdmin,
      ifMatch: profile.revision,
      body: { dataOperations: {}, fields: [], buttons: [], padding: 'x'.repeat(520 * 1024) },
    });
    expect(huge.status).toBe(413);
    expect(await errorCode(huge)).toBe('PAYLOAD_TOO_LARGE');

    const other = await world.api.request('POST', `${BASE}/profiles`, {
      ...world.asAdmin,
      body: { code: 'too-big', name: '超大', apps: [], description: 'x'.repeat(DEFAULT_LIMIT) },
    });
    expect(other.status).toBe(413);
  });
});
