/**
 * 演示配套：当前用户权限快照接口 GET /api/tenant/permission/me/snapshot（DEC-469）。
 * 快照的应用可见性与对象入口必须与逐对象 /me/objects、授权器 object.view 的结论一致；
 * 租户管理员对配置类对象（任职 / 合同设置）也要一致允许；请求只读。
 */
import { randomUUID } from 'node:crypto';
import { createPermissionAuthorizer } from '@italent/api';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PEOPLE, DEMO_TENANT } from '../../apps/api/src/demo/data.js';
import { type DemoManifest, seedDemo } from '../../apps/api/src/demo/seed.js';
import { menuObjects } from '../../apps/web/src/foundation/permission-snapshot.js';
import { APP_ROUTES } from '../../apps/web/src/foundation/routes.js';
import { addMember, seedPermissionWorld } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-07';
const clock = () => new Date(`${TODAY}T02:00:00.000Z`);
const SNAPSHOT = '/api/tenant/permission/me/snapshot';

interface Snapshot {
  session: {
    tenantId: string;
    tenantName: string;
    timezone: string;
    today: string;
    userId: string;
    displayName: string;
    employeeId: string | null;
  };
  apps: { app: string; visible: boolean; entryObjects: string[] }[];
  scope: { app: string; status: 'all' | 'limited' | 'none'; organizationIds: string[]; truncated: boolean }[];
  adminMenus: { code: string; path: string; implemented: boolean; editable: boolean }[];
}
type Who = { user: string; tenant: string };

describe('当前用户权限快照（演示租户）', () => {
  let manifest: DemoManifest;
  let api: ReturnType<typeof tenantApi>;
  const people = new Map<string, Who & { name: string }>();

  async function json<T>(who: Who, path: string): Promise<T> {
    const response = await api.request('GET', path, who);
    expect(response.status, `${path} ${await response.clone().text()}`).toBe(200);
    return (await response.json()) as T;
  }
  const snapshotOf = (who: Who) => json<Snapshot>(who, SNAPSHOT);

  beforeAll(async () => {
    const seeded = await seedDemo(database().db, { clock, nodeEnv: 'test' });
    manifest = seeded.manifest;
    api = tenantApi(database().db, { authorize: undefined, clock });
    for (const person of DEMO_PEOPLE) {
      const persona = manifest.personas.find((p) => p.name === person.name)!;
      people.set(person.key, { user: persona.userId, tenant: manifest.tenantId, name: person.name });
    }
    // 第六类：租户成员，但没有任何身份 / 管理员 / 员工绑定
    const nobody = await createUser(
      database().db,
      { email: `nobody-${randomUUID()}@example.com`, displayName: '无权限用户（演示）' },
      cmd(),
    );
    await grantMembership(
      database().db,
      { tenantId: manifest.tenantId, userId: nobody.id, expectedRevision: 0 },
      cmd(),
    );
    people.set('nobody', { user: nobody.id, tenant: manifest.tenantId, name: nobody.displayName });
  }, 180_000);

  /** 旧前端做法：逐应用逐对象探测 /me/objects 与专用接口，推出每个应用的可见性与入口对象。 */
  async function probed(who: Who) {
    const status = async (path: string) => (await api.request('GET', path, who)).status;
    const result = new Map<string, { visible: boolean; entryObjects: string[] }>();
    for (const route of APP_ROUTES) {
      const codes = menuObjects(route);
      const statuses = await Promise.all(
        codes.map((code) => status(`/api/tenant/permission/me/objects/${encodeURIComponent(code)}`)),
      );
      const entryObjects = codes.filter((_, index) => statuses[index] === 200);
      let visible = entryObjects.length > 0;
      if (route.id === 'settings') {
        visible = (await json<{ items: unknown[] }>(who, '/api/tenant/permission/admin-menus')).items.length > 0;
      } else if (route.id === 'self') {
        visible = (await status('/api/tenant/self-service/profile')) === 200;
      } else if (route.id === 'manager') {
        const response = await api.request('GET', '/api/tenant/employment/transfers/manager', who);
        const body = response.status === 200 ? ((await response.json()) as Record<string, boolean>) : {};
        visible = !!(body.canApply || body.canViewReporting);
      } else if (route.id === 'approval') {
        visible = (await status('/api/tenant/approval/todos?page=1&pageSize=1')) === 200;
      }
      result.set(route.id, { visible, entryObjects });
    }
    return result;
  }

  it('响应字段齐全、应用按前端顺序、体积在 32KB 内，adminMenus 与 admin-menus 接口相同', async () => {
    const who = people.get('admin')!;
    const response = await api.request('GET', SNAPSHOT, who);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    const body = JSON.parse(text) as Snapshot;
    expect(Object.keys(body).sort()).toEqual(['adminMenus', 'apps', 'scope', 'session']);
    expect(body.apps.map((a) => a.app)).toEqual(APP_ROUTES.map((r) => r.id));
    expect(body.adminMenus).toEqual(
      (await json<{ items: unknown[] }>(who, '/api/tenant/permission/admin-menus')).items,
    );
    expect(body.adminMenus.length).toBeGreaterThan(0);
  });

  // 每类身份逐对象调用约 220 次接口 / 授权器，分成独立用例并放宽超时
  it.each(['admin', 'hr', 'platformManager', 'employeeA', 'auditor', 'nobody'])(
    '身份 %s：快照的 visible / entryObjects 与逐对象 /me/objects 推出的结论一致，且与授权器 object.view 一致',
    async (key) => {
      const authorize = createPermissionAuthorizer(database().db, undefined, clock);
      const who = people.get(key)!;
      const snapshot = await snapshotOf(who);
      const expected = await probed(who);
      for (const item of snapshot.apps) {
        expect({ visible: item.visible, entryObjects: item.entryObjects }, `${key} 的应用 ${item.app}`).toEqual(
          expected.get(item.app),
        );
      }
      for (const route of APP_ROUTES) {
        const entries = snapshot.apps.find((a) => a.app === route.id)!.entryObjects;
        const codes = menuObjects(route);
        const allowed = await Promise.all(
          codes.map((code) =>
            authorize({ tenantId: who.tenant, userId: who.user, action: 'object.view', resource: code }),
          ),
        );
        codes.forEach((code, index) =>
          expect(entries.includes(code), `${key} ${code} 授权器=${allowed[index]}`).toBe(allowed[index]),
        );
      }
    },
    300_000,
  );

  it('无权限用户：只有“不依赖对象授权”的入口可能可见（审批中心），其余应用全部不可见且数据范围为 none', async () => {
    const snapshot = await snapshotOf(people.get('nobody')!);
    expect(snapshot.apps.filter((a) => a.visible).map((a) => a.app)).toEqual(['approval']);
    expect(snapshot.apps.flatMap((a) => a.entryObjects)).toEqual([]);
    expect(snapshot.adminMenus).toEqual([]);
    expect(snapshot.session.employeeId).toBeNull();
    expect(snapshot.scope.every((s) => s.status === 'none' && s.organizationIds.length === 0)).toBe(true);
  });

  it('经理默认身份：manager 可见，调动入口可见，员工入口可见；普通员工 self 可见而 manager 不可见', async () => {
    const manager = await snapshotOf(people.get('platformManager')!);
    const visible = (s: Snapshot) => new Set(s.apps.filter((a) => a.visible).map((a) => a.app));
    expect(visible(manager).has('manager')).toBe(true);
    expect(visible(manager).has('transfer')).toBe(true);
    const employee = await snapshotOf(people.get('employeeA')!);
    expect(visible(employee).has('self')).toBe(true);
    expect(visible(employee).has('manager')).toBe(false);
  });

  it('数据范围三态：系统管理员 all，HR 为带组织集合的 limited，无权限用户 none', async () => {
    const scopeOf = (s: Snapshot, app: string) => s.scope.find((x) => x.app === app)!;
    const admin = await snapshotOf(people.get('admin')!);
    expect(scopeOf(admin, 'org')).toMatchObject({ status: 'all', organizationIds: [], truncated: false });
    const hr = await snapshotOf(people.get('hr')!);
    const hrScope = scopeOf(hr, 'org');
    expect(hrScope.status).toBe('limited');
    expect(hrScope.truncated).toBe(false);
    const orgs = await json<{ items: { id: string; name: string }[] }>(
      people.get('hr')!,
      `/api/tenant/org/organizations?asOf=${TODAY}&pageSize=200`,
    );
    expect(new Set(hrScope.organizationIds)).toEqual(new Set(orgs.items.map((o) => o.id)));
    const nobody = await snapshotOf(people.get('nobody')!);
    expect(scopeOf(nobody, 'org')).toMatchObject({ status: 'none', organizationIds: [], truncated: false });
  });

  it('session 取自真实租户资料与当前用户，不硬编码', async () => {
    const employee = people.get('employeeA')!;
    const profile = await json<{ employee: { id: string } }>(employee, '/api/tenant/self-service/profile');
    const snapshot = await snapshotOf(employee);
    expect(snapshot.session).toEqual({
      tenantId: manifest.tenantId,
      tenantName: DEMO_TENANT.name,
      timezone: DEMO_TENANT.timezone,
      today: tenantLocalDate(clock(), DEMO_TENANT.timezone),
      userId: employee.user,
      displayName: employee.name,
      employeeId: profile.employee.id,
    });
    const admin = await snapshotOf(people.get('admin')!);
    expect(admin.session.employeeId).toBeNull();
    expect(admin.session.displayName).toBe(people.get('admin')!.name);
  });

  it('请求只读：租户内全部带 tenant_id 的表行数在请求前后不变', async () => {
    const db = database().db;
    const counts = () =>
      withTenant(db, manifest.tenantId, async (tx) => {
        const tables = (await tx.execute(
          sql`SELECT DISTINCT table_name AS name FROM information_schema.columns
              WHERE table_schema='public' AND column_name='tenant_id' ORDER BY 1`,
        )) as unknown as { name: string }[] | { rows: { name: string }[] };
        const names = (Array.isArray(tables) ? tables : tables.rows).map((row) => row.name);
        const result: Record<string, number> = {};
        for (const name of names) {
          const rows = (await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM "${name}"`))) as unknown as
            { n: number }[] | { rows: { n: number }[] };
          result[name] = (Array.isArray(rows) ? rows : rows.rows)[0]!.n;
        }
        return result;
      });
    const before = await counts();
    for (const key of ['admin', 'hr', 'platformManager', 'employeeA', 'auditor', 'nobody'])
      await snapshotOf(people.get(key)!);
    expect(await counts()).toEqual(before);
    expect(Object.keys(before).length).toBeGreaterThan(20);
  });
});

describe('租户管理员对配置类对象（任职设置 / 合同设置）', () => {
  it('快照与 /me/objects 都允许，普通成员两者都不允许', async () => {
    const world = await seedPermissionWorld(database().db);
    const admin = world.asAdmin;
    const member = await addMember(world, 'cfg-plain');
    const plain = { user: member.id, tenant: world.tenant.id };
    const configs = [
      MODULE_OBJECTS.employmentSettings.code,
      MODULE_OBJECTS.employmentCustomField.code,
      MODULE_OBJECTS.contractSettings.code,
      MODULE_OBJECTS.contractRules.code,
    ];
    const read = async (who: Who) => (await (await world.api.request('GET', SNAPSHOT, who)).json()) as Snapshot;
    for (const code of configs) {
      const mine = await world.api.request('GET', `/api/tenant/permission/me/objects/${code}`, admin);
      expect(mine.status, `/me/objects ${code}`).toBe(200);
      const other = await world.api.request('GET', `/api/tenant/permission/me/objects/${code}`, plain);
      expect(other.status, `/me/objects ${code}（普通成员）`).toBe(403);
    }
    const settings = (await read(admin)).apps.find((a) => a.app === 'settings')!;
    for (const code of configs) expect(settings.entryObjects, code).toContain(code);
    expect(settings.visible).toBe(true);
    const plainSettings = (await read(plain)).apps.find((a) => a.app === 'settings')!;
    expect(plainSettings).toEqual({ app: 'settings', visible: false, entryObjects: [] });
  });
});
