/** F-038：模型图审计必须复用标准查看权与当前管理单元范围，删除快照无图片字节。 */
import { randomUUID } from 'node:crypto';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { createProfile, grant, makeGrantable, seedPermissionWorld, setObjectPermission } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { clock, seedTalentData } from './AC-TC-permission-support.js';
import { assignTalentMou, TC_BASE, TC_NOW } from './AC-TC-support.js';
import { tenantApi } from './support/tenant-api.js';
import {
  expectImageError,
  imageFixture,
  MODEL_IMAGE_AUDIT_TYPE,
  modelPath,
  registerImage,
  uploadImage,
  type ImageRequest,
} from './AC-TC-model-image-support.js';

const testDb = useTestDb();

describe('AC-TC（补）F-038 模型图审计真实查看权限', () => {
  it('无标准权、空范围、范围外记录均不可见；撤范围后旧日志详情 404，图字段不受其他标准字段裁剪', async () => {
    const db = testDb().db;
    let world = await seedPermissionWorld(db);
    world = { ...world, api: tenantApi(db, { authorize: undefined, clock }) };
    const data = await seedTalentData(world);
    const request: ImageRequest = (method, path, options = {}) =>
      data.setup.request(method, `${TC_BASE}${path}`, { ...world.asAdmin, ...options });
    const fixture = imageFixture();
    for (const owned of [data.inside, data.outside]) {
      const registered = await registerImage(request, owned.criterion.id, owned.criterion.revision, fixture);
      const uploaded = await uploadImage(request, owned.criterion.id, registered, fixture);
      const deleted = await request('DELETE', modelPath(owned.criterion.id), { ifMatch: uploaded.revision });
      expect(deleted.status).toBe(200);
    }
    const audit = auditApi(db, TC_NOW.toISOString(), { authorize: undefined });
    const viewer = await memberWithAdminRole(world, 'audit_admin', 'model-image-audit');
    const query = { objectType: MODEL_IMAGE_AUDIT_TYPE, limit: '50' };
    expect((await audit.dataChanges(viewer.as, query)).items).toEqual([]);

    const profile = await createProfile(world, `model-audit-${randomUUID().slice(0, 8)}`, { apps: [TALENT_APP] });
    const definition = TALENT_OBJECTS.criterion;
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: field.system, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, viewer.user.id, profile.id)).status).toBe(201);
    expect((await audit.dataChanges(viewer.as, query)).items).toEqual([]);
    const revision = await assignTalentMou(world.api, world.asAdmin, viewer.user.id, data.mouId, 0);
    const logs = (await audit.dataChanges(viewer.as, query)).items;
    expect(logs).toHaveLength(3);
    expect(new Set(logs.map((entry) => entry.objectId))).toEqual(new Set([data.inside.criterion.id]));
    expect(logs.map((entry) => entry.action).sort()).toEqual([
      'talent.criterion.model-image.delete',
      'talent.criterion.model-image.register',
      'talent.criterion.model-image.upload',
    ]);
    const deletion = logs.find((entry) => entry.action === 'talent.criterion.model-image.delete')!;
    const detail = await audit.dataChange(viewer.as, deletion.id);
    expect(detail.before).toMatchObject({ modelImage: fixture.metadata });
    expect(detail.after).toMatchObject({ modelImage: null });
    expect(detail.changes.map((change) => change.field).sort()).toEqual([
      'modelImage.byteSize',
      'modelImage.contentType',
      'modelImage.filename',
      'modelImage.sha256',
    ]);
    expect(JSON.stringify(detail)).not.toContain(fixture.base64);
    expect(JSON.stringify(detail)).not.toContain('contentBase64');
    expect(JSON.stringify(detail)).not.toContain('内总监标准');
    await assignTalentMou(world.api, world.asAdmin, viewer.user.id, null, revision);
    expect((await audit.dataChanges(viewer.as, query)).items).toEqual([]);
    await expectImageError(await audit.get(`/data-changes/${deletion.id}`, viewer.as), 404, 'NOT_FOUND');
  });
});
