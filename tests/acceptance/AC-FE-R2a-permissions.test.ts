/**
 * F-127b 第 2 轮：合同协议冒烟的对象权限夹具必须与 GET /me/objects 的真实返回形态一致，不虚构按钮。
 *   - 配置类对象（合同设置、续签规则）：与租户管理员实际拿到的返回逐字段相等（buttons 为空、不可删除）；
 *   - 普通对象（合同、合同类型）：按钮属于领域定义，且所需数据操作已授予（executableButtons 的过滤口径），
 *     字段属于定义，系统字段不可编辑。
 */
import { DATA_OPERATIONS, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { objectPermissions } from '../../apps/web/smoke/contracts-permissions.js';
import { seedPermissionWorld } from './AC-PRM-support.js';

const database = useTestDb();

describe('AC-FE-R2a 冒烟权限夹具与接口形态一致', () => {
  it('配置类对象：夹具等于租户管理员的 /me/objects 返回', async () => {
    const world = await seedPermissionWorld(database().db);
    for (const fixture of [objectPermissions.rules, objectPermissions.settings]) {
      const res = await world.api.request(
        'GET',
        `/api/tenant/permission/me/objects/${encodeURIComponent(fixture.objectCode)}`,
        world.asAdmin,
      );
      expect(res.status, fixture.objectCode).toBe(200);
      expect(await res.json(), fixture.objectCode).toEqual(fixture);
    }
  });

  it.each([
    ['contract', objectPermissions.contract, MODULE_OBJECTS.contract],
    ['type', objectPermissions.type, MODULE_OBJECTS.contractType],
  ] as const)('普通对象 %s：按钮与字段都可由领域定义推出', (_name, fixture, definition) => {
    expect(fixture.objectCode).toBe(definition.code);
    expect(Object.keys(fixture.dataOperations).sort()).toEqual([...DATA_OPERATIONS].sort());
    const operations = fixture.dataOperations as Record<string, boolean>;
    for (const { buttonCode, level } of fixture.buttons) {
      const defined = definition.buttons.find((button) => button.code === buttonCode && button.level === level);
      expect(defined, `${buttonCode}@${level}`).toBeDefined();
      const requires = (defined as { requires?: string }).requires;
      if (requires) expect(operations[requires], `${buttonCode} 需要 ${requires}`).toBe(true);
    }
    const fields = new Map(definition.fields.map((field) => [field.code, field.system]));
    for (const field of fixture.viewableFields) expect(fields.has(field), field).toBe(true);
    for (const field of fixture.editableFields) {
      expect(fields.get(field), `${field} 不是系统字段`).toBe(false);
      expect(fixture.viewableFields, field).toContain(field);
    }
  });
});
