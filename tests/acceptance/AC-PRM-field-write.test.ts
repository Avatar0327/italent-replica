/**
 * 写入字段权限的服务端强制校验（REQ-PRM-001 字段权限；DEC-042；Codex 审计 PR #8 第 2 条）：
 * 业务对象写路由调用 requireObjectWrite，按服务端解析后的载荷字段判定——
 * 任一字段全部身份都不可编辑（含系统字段、未登记字段）→ 403 整单拒绝；任一身份可编辑即可写（并集）。
 * 这里用测试夹具路由模拟一个业务对象的编辑接口。
 */
import { defineTable, requireObjectWrite, type TenantRouteModule, tenantOf } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  DEMO_OBJECT,
  grant,
  makeGrantable,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const PATH = '/api/tenant/test-fixture/demo-records/1';

/** 夹具：模拟业务模块的编辑接口（先做字段权限校验，再执行业务写）。 */
/** 夹具路由的声明（F-039）：createApp 要求每条注册都有声明。 */
const demoWritePolicies = defineTable('demo', {
  [`PUT ${PATH}`]: {
    kind: 'member',
    reason: '测试夹具：对象字段编辑权（requireObjectWrite）',
    fields: { mode: 'none', reason: '测试夹具' },
    write: { fields: 'body', footprint: { none: true, reason: '测试夹具' }, result: { none: true, reason: '测试夹具' } },
  },
});
const demoWriteRoute: TenantRouteModule = (router, deps) => {
  router.put(PATH, async (c) => {
    const payload = (await c.req.json()) as Record<string, unknown>;
    await requireObjectWrite(deps.authorize, tenantOf(c), {
      objectCode: DEMO_OBJECT.code,
      operation: 'update',
      payload,
    });
    return c.json({ written: Object.keys(payload).sort() });
  });
};

describe('写入字段权限：全部身份都不可编辑的字段写入被拒', () => {
  let world: PermissionWorld;
  let api: ReturnType<typeof tenantApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    api = tenantApi(world.db, { authorize: undefined, tenantRoutes: [demoWriteRoute], routePolicies: [demoWritePolicies] });
  });

  it('只可编辑 Name：写 Name 放行；带上只读字段、系统字段、未登记字段 → 403；叠加可编辑手机的身份后放行', async () => {
    const nameEditor = await createProfile(world, 'name-editor');
    await setObjectPermission(world, nameEditor, {
      dataOperations: { create: false, update: true, delete: false },
      fields: [
        { fieldCode: 'Name', view: true, edit: true },
        { fieldCode: 'MobilePhone', view: true, edit: false },
        { fieldCode: 'CreatedBy', view: true, edit: false },
      ],
      buttons: [],
    });
    const phoneEditor = await createProfile(world, 'phone-editor');
    await setObjectPermission(world, phoneEditor, {
      dataOperations: { create: false, update: false, delete: false },
      fields: [{ fieldCode: 'MobilePhone', view: true, edit: true }],
      buttons: [],
    });
    await makeGrantable(world, [nameEditor.id, phoneEditor.id]);
    const user = await addMember(world, 'writer');
    expect((await grant(world, user.id, nameEditor.id)).status).toBe(201);

    const put = (body: Record<string, unknown>) =>
      api.request('PUT', PATH, { user: user.id, tenant: world.tenant.id, body });
    expect(await (await put({ Name: '张三' })).json()).toEqual({ written: ['Name'] });
    for (const body of [{ Name: '张三', MobilePhone: '1' }, { CreatedBy: 'x' }, { Name: '张三', Nope: 1 }]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(await errorCode(res)).toBe('FORBIDDEN');
    }

    // DEC-042：另一身份可编辑手机号（即便它自己的「编辑」开关关闭，开关取并集）→ 放行
    expect((await grant(world, user.id, phoneEditor.id)).status).toBe(201);
    expect((await put({ Name: '张三', MobilePhone: '1' })).status).toBe(200);
    // 系统字段任何身份都不可写
    expect((await put({ Name: '张三', CreatedBy: 'x' })).status).toBe(403);
  });

  it('没有任何身份的用户：空载荷也拒绝（无对象权限）', async () => {
    const user = await addMember(world, 'nobody');
    const res = await api.request('PUT', PATH, { user: user.id, tenant: world.tenant.id, body: {} });
    expect(res.status).toBe(403);
  });
});
