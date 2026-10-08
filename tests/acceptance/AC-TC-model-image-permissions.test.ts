/** F-038 模型图随标准对象的当前权限：无独立图权限，服务端范围、按钮与重放都不能绕过。 */
import { randomUUID } from 'node:crypto';
import { TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import { clock, seedTalentData, talentOperator, type TalentPermissionData } from './AC-TC-permission-support.js';
import { TC_BASE, talentWorld, type CriterionView } from './AC-TC-support.js';
import { tenantApi } from './support/tenant-api.js';
import {
  contentPath,
  expectImageError,
  imageFixture,
  modelPath,
  readModel,
  registerImage,
  uploadImage,
  type ImageRequest,
} from './AC-TC-model-image-support.js';

const testDb = useTestDb();

describe('AC-TC（补）F-038 潜力模型图权限与撤权重放', () => {
  let world: PermissionWorld;
  let data: TalentPermissionData;
  let adminRequest: ImageRequest;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    data = await seedTalentData(world);
    adminRequest = (method, path, options = {}) =>
      data.setup.request(method, `${TC_BASE}${path}`, { ...world.asAdmin, ...options });
  });

  const criterion = async (orgId = data.inside.orgId): Promise<CriterionView> => {
    const response = await adminRequest('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId: data.inside.criterionCategory.id,
        name: `权限合成标准 ${randomUUID()}`,
        ownerOrgId: orgId,
        dimensions: [],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as CriterionView;
  };

  it('范围外与不存在的标准同一个 404，图登记/上传/删除/内容读取均不能改变业务', async () => {
    const parent = await criterion(data.outside.orgId);
    const registered = await registerImage(adminRequest, parent.id, parent.revision);
    const uploaded = await uploadImage(adminRequest, parent.id, registered);
    const op = await talentOperator(world, { objects: ['criterion'], mouId: data.mouId });
    const before = await readModel(adminRequest, parent.id);
    const outside = await op.request('GET', modelPath(parent.id));
    const ghost = await op.request('GET', modelPath(randomUUID()));
    expect([outside.status, ghost.status]).toEqual([404, 404]);
    expect(await outside.json()).toEqual(await ghost.json());
    const cases = [
      ['POST', `${modelPath(parent.id)}/attachments`, imageFixture().metadata],
      [
        'POST',
        `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`,
        { base64: imageFixture().base64 },
      ],
      ['DELETE', modelPath(parent.id), undefined],
      ['GET', contentPath(parent.id, registered.attachment.id), undefined],
    ] as const;
    for (const [method, path, body] of cases) {
      await expectImageError(await op.request(method, path, { ifMatch: uploaded.revision, body }), 404, 'NOT_FOUND');
      expect(await readModel(adminRequest, parent.id)).toEqual(before);
    }
  });

  it.each(['update', 'button'] as const)('没有标准 %s 权时可看图但 canEdit=false，三种写操作 403', async (denied) => {
    const parent = await criterion();
    const registered = await registerImage(adminRequest, parent.id, parent.revision);
    const uploaded = await uploadImage(adminRequest, parent.id, registered);
    const op = await talentOperator(world, {
      objects: ['criterion'],
      mouId: data.mouId,
      ...(denied === 'button' ? { buttons: false } : {}),
      ...(denied === 'update' ? { operations: { criterion: { create: false, update: false, delete: true } } } : {}),
    });
    expect(await readModel(op.request, parent.id)).toMatchObject({ canEdit: false, modelImage: uploaded.modelImage });
    expect((await op.request('GET', contentPath(parent.id, registered.attachment.id))).status).toBe(200);
    const before = await readModel(adminRequest, parent.id);
    const cases = [
      ['POST', `${modelPath(parent.id)}/attachments`, imageFixture('bmp').metadata],
      [
        'POST',
        `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`,
        { base64: imageFixture().base64 },
      ],
      ['DELETE', modelPath(parent.id), undefined],
    ] as const;
    for (const [method, path, body] of cases) {
      await expectImageError(await op.request(method, path, { ifMatch: uploaded.revision, body }), 403, 'FORBIDDEN');
      expect(await readModel(adminRequest, parent.id)).toEqual(before);
    }
  });

  it('没有标准查看权时模型元数据与内容都返回 403，指标查看权不代替标准查看权', async () => {
    const parent = await criterion();
    const registered = await registerImage(adminRequest, parent.id, parent.revision);
    await uploadImage(adminRequest, parent.id, registered);
    const op = await talentOperator(world, { objects: ['dimension'], mouId: data.mouId });
    const before = await readModel(adminRequest, parent.id);
    await expectImageError(await op.request('GET', modelPath(parent.id)), 403, 'FORBIDDEN');
    await expectImageError(await op.request('GET', contentPath(parent.id, registered.attachment.id)), 403, 'FORBIDDEN');
    expect(await readModel(adminRequest, parent.id)).toEqual(before);
  });

  it('只有标准编辑权和编辑按钮即可登记/上传/删图，不依赖标准删除权、指标权或独立图字段权', async () => {
    const parent = await criterion();
    const op = await talentOperator(world, {
      objects: ['criterion'],
      mouId: data.mouId,
      operations: { criterion: { create: false, update: true, delete: false } },
      readonly: { criterion: TALENT_OBJECTS.criterion.fields.map((field) => field.code) },
    });
    expect((await readModel(op.request, parent.id)).canEdit).toBe(true);
    const registered = await registerImage(op.request, parent.id, parent.revision);
    const uploaded = await uploadImage(op.request, parent.id, registered);
    const deleted = await op.request('DELETE', modelPath(parent.id), { ifMatch: uploaded.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await readModel(adminRequest, parent.id)).modelImage).toBeNull();
  });

  it('跨租户标识及同租户另一标准的附件标识均 404，原图不变', async () => {
    const parent = await criterion();
    const registered = await registerImage(adminRequest, parent.id, parent.revision);
    const uploaded = await uploadImage(adminRequest, parent.id, registered);
    const other = await talentWorld(testDb().db, 'model-image-other-tenant');
    const before = await readModel(adminRequest, parent.id);
    await expectImageError(await other.request('GET', modelPath(parent.id)), 404, 'NOT_FOUND');
    await expectImageError(
      await other.request('GET', contentPath(parent.id, registered.attachment.id)),
      404,
      'NOT_FOUND',
    );
    await expectImageError(
      await other.request('POST', `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: uploaded.revision,
        body: { base64: imageFixture().base64 },
      }),
      404,
      'NOT_FOUND',
    );
    const sibling = await criterion();
    await expectImageError(
      await adminRequest('GET', contentPath(sibling.id, registered.attachment.id)),
      404,
      'NOT_FOUND',
    );
    await expectImageError(
      await adminRequest('POST', `${modelPath(sibling.id)}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: sibling.revision,
        body: { base64: imageFixture().base64 },
      }),
      404,
      'NOT_FOUND',
    );
    expect(await readModel(adminRequest, parent.id)).toEqual(before);
    expect((await readModel(adminRequest, sibling.id)).revision).toBe(sibling.revision);
  });

  it.each(['scope', 'button', 'update'] as const)(
    '撤 %s 后原登记/上传/删除命令重放按当前权限拒绝，图不复活',
    async (revoked) => {
      const parent = await criterion();
      const op = await talentOperator(world, { objects: ['criterion'], mouId: data.mouId });
      const fixture = imageFixture();
      const registerKey = randomUUID();
      const uploadKey = randomUUID();
      const deleteKey = randomUUID();
      const registered = await registerImage(op.request, parent.id, parent.revision, fixture, registerKey);
      const uploaded = await uploadImage(op.request, parent.id, registered, fixture, uploadKey);
      const deleted = await op.request('DELETE', modelPath(parent.id), {
        ifMatch: uploaded.revision,
        idempotencyKey: deleteKey,
      });
      expect(deleted.status).toBe(200);
      if (revoked === 'scope') await op.setMou(null);
      else if (revoked === 'button') await op.setButtons(false);
      else {
        const definition = TALENT_OBJECTS.criterion;
        const response = await setObjectPermission(
          world,
          op.profile,
          {
            dataOperations: { create: true, update: false, delete: true },
            fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
            buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
          },
          definition.code,
        );
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const before = await readModel(adminRequest, parent.id);
      const cases = [
        [`${modelPath(parent.id)}/attachments`, parent.revision, fixture.metadata, registerKey, 'POST'],
        [
          `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`,
          registered.revision,
          { base64: fixture.base64 },
          uploadKey,
          'POST',
        ],
        [modelPath(parent.id), uploaded.revision, undefined, deleteKey, 'DELETE'],
      ] as const;
      for (const [path, ifMatch, body, idempotencyKey, method] of cases) {
        await expectImageError(
          await op.request(method, path, { ifMatch, body, idempotencyKey }),
          revoked === 'scope' ? 404 : 403,
          revoked === 'scope' ? 'NOT_FOUND' : 'FORBIDDEN',
        );
        expect(await readModel(adminRequest, parent.id)).toEqual(before);
      }
      expect(before.modelImage).toBeNull();
      await expectImageError(
        await adminRequest('GET', contentPath(parent.id, registered.attachment.id)),
        404,
        'NOT_FOUND',
      );
    },
  );
});
