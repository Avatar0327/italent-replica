/** F-035：编辑权与查看权分别解析时也禁止盲写；裁剪明细不阻止其余字段 PATCH。 */
import { TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedPermissionWorld, setObjectPermission } from './AC-PRM-support.js';
import { clock, seedTalentData, talentOperator } from './AC-TC-permission-support.js';
import { TC_BASE } from './AC-TC-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-TC-F035 可编辑但不可见字段不得盲写', () => {
  it('真实授权器 view=false/edit=true：显式清空与明细替换 403，获准定义仍可保存且所有裁剪值保持', async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    const world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock }) };
    const data = await seedTalentData(world);
    const op = await talentOperator(world, { seeAll: true });
    const definition = TALENT_OBJECTS.dimension;
    const hidden = new Set(['categoryId', 'grades', 'suggestions']);
    const permission = await setObjectPermission(
      world,
      op.profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.has(field.code),
          edit: !field.system,
        })),
        buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    const path = `/dimensions/${data.inside.dimension.id}`;
    const read = async () => {
      const response = await data.setup.request('GET', `${TC_BASE}${path}`, world.asAdmin);
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown> & { revision: number };
    };
    const before = await read();
    for (const body of [{ categoryId: null }, { grades: [] }, { suggestions: [], definition: '不能整体成功' }]) {
      const response = await op.request('PATCH', path, { ifMatch: before.revision, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(await errorCode(response)).toBe('FORBIDDEN');
      expect(await read()).toEqual(before);
    }
    const saved = await op.request('PATCH', path, { ifMatch: before.revision, body: { definition: '获准新定义' } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const shown = (await saved.json()) as Record<string, unknown>;
    expect(shown.definition).toBe('获准新定义');
    for (const key of hidden) expect(shown).not.toHaveProperty(key);
    expect(await read()).toEqual({ ...before, definition: '获准新定义', revision: before.revision + 1 });
  });
});
