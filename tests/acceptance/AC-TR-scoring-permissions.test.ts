/**
 * R3-T04 PR-B2a 评价规则 / 模块等级的权限（真实授权器；设计 §6.1、§6.5“配置对象”行；DEC-080 / 121 / 082 / 043）：
 * 两个对象都没有组织字段，数据范围只认看全部或创建人（缺省为空），新建只有看全部可建，范围外与不存在同一个 404；
 * 写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权；撤按钮 / 撤范围后原命令重放同样被拒；响应按字段权限裁剪；
 * 列表筛选字段同受字段查看权约束。负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import {
  configOperator,
  gradeRuleBody,
  moduleGradeBody,
  scoreItems,
  TR_BASE,
  TR_NOW,
  type ConfigView,
} from './AC-TR-scoring-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

describe.each([
  {
    object: 'scoreRule',
    path: '/score-rules',
    body: (name = `权限规则${Math.random()}`) => gradeRuleBody({ name }),
    secret: 'allowUnable',
    nested: 'levels',
    attempt: { allowUnable: true },
    patch: { enabled: false },
    filter: 'enabled',
  },
  {
    object: 'moduleGrade',
    path: '/module-grades',
    body: (name = `权限等级${Math.random()}`) => moduleGradeBody({ name }),
    secret: 'items',
    nested: 'items',
    attempt: { items: scoreItems(0, 1) },
    patch: { enabled: false },
    filter: 'enabled',
  },
] as const)(
  '配置对象权限 · $object（DEC-121 / 082 / 043）',
  ({ object, path, body, secret, nested, attempt, patch, filter }) => {
    let world: PermissionWorld;
    let setup: ReturnType<typeof tenantApi>;
    let existing: ConfigView;
    const adminRead = async (id: string) =>
      (await (await setup.request('GET', `${TR_BASE}${path}/${id}`, world.asAdmin)).json()) as ConfigView;

    beforeAll(async () => {
      world = await seedPermissionWorld(testDb().db);
      world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
      setup = tenantApi(world.db, { clock });
      const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body: body() });
      expect(response.status, await response.clone().text()).toBe(201);
      existing = (await response.json()) as ConfigView;
    });

    it('没有对象查看权 403；有查看权但范围为空：列表空、他人建的详情 404、新建 404 且不落库、修改 404', async () => {
      const none = await configOperator(world, object, { view: false });
      expect((await none.request('GET', path)).status).toBe(403);
      const operator = await configOperator(world, object);
      expect(await (await operator.request('GET', path)).json()).toMatchObject({ items: [], hasDataPermission: false });
      const detail = await operator.request('GET', `${path}/${existing.id}`);
      expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
      const draft = body();
      expect((await operator.request('POST', path, { ifMatch: 0, body: draft })).status).toBe(404);
      const names = (
        (await (await setup.request('GET', `${TR_BASE}${path}?pageSize=100`, world.asAdmin)).json()) as {
          items: { name: string }[];
        }
      ).items.map((item) => item.name);
      expect(names).not.toContain(draft.name);
      expect((await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: patch })).status).toBe(404);
      expect(await adminRead(existing.id)).toEqual(existing);
    });

    it('看全部：可见他人建的；隐藏字段键缺席、写隐藏 / 只读字段 403 数据不变；看不到筛选字段不能筛选', async () => {
      const operator = await configOperator(world, object, {
        seeAll: true,
        hidden: [secret, nested],
        readonly: ['name'],
      });
      const detail = (await (await operator.request('GET', `${path}/${existing.id}`)).json()) as object;
      expect(detail).toMatchObject({ id: existing.id });
      expect(detail).not.toHaveProperty(secret);
      expect(detail).not.toHaveProperty(nested); // 子表（等级 / 项）同样按字段查看权裁剪
      for (const payload of [attempt, { name: '改' }]) {
        const response = await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: payload });
        expect(response.status, JSON.stringify(payload)).toBe(403);
      }
      expect(await adminRead(existing.id)).toEqual(existing);
      const hiddenFilter = await configOperator(world, object, { seeAll: true, hidden: [filter] });
      const filtered = await hiddenFilter.request('GET', `${path}?${filter}=true`);
      expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
      expect((await hiddenFilter.request('GET', path)).status).toBe(200);
    });

    it('列表排序只用查看人看得到的字段（PR #182 口径）：看不到名称时不按名称排，只按 id 收尾', async () => {
      const w = await seedPermissionWorld(testDb().db);
      const api = tenantApi(w.db, { clock });
      for (const label of ['戊', '丁', '丙', '乙', '甲', '癸']) {
        const response = await api.request('POST', `${TR_BASE}${path}`, {
          ...w.asAdmin,
          ifMatch: 0,
          body: body(`排序${label}`),
        });
        expect(response.status, await response.clone().text()).toBe(201);
      }
      const names = async (hidden: string[]) => {
        const operator = await configOperator({ ...w, api: tenantApi(w.db, { authorize: undefined, clock }) }, object, {
          seeAll: true,
          hidden,
        });
        const { items } = (await (await operator.request('GET', `${path}?pageSize=100`)).json()) as {
          items: { id: string; name?: string }[];
        };
        return items;
      };
      const hidden = await names(['name']);
      expect(hidden.map((item) => item.id)).toEqual([...hidden.map((item) => item.id)].sort());
    });

    it('撤按钮后新请求与原命令重放都 403；撤看全部后重放 404', async () => {
      const operator = await configOperator(world, object, { seeAll: true });
      const options = { ifMatch: 0, idempotencyKey: `trs-replay-${object}-${Date.now()}`, body: body() };
      expect((await operator.request('POST', path, options)).status).toBe(201);
      await operator.setButtons(false);
      expect((await operator.request('POST', path, options)).status).toBe(403);
      expect((await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: patch })).status).toBe(403);
      await operator.setButtons(true);
      await operator.setSeeAll(false);
      expect((await operator.request('POST', path, options)).status).toBe(404);
      expect(await adminRead(existing.id)).toEqual(existing);
    });
  },
);
