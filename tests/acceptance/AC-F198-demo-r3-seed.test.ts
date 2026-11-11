/**
 * F-198 演示种子补 R3 权限与样例数据：切到系统管理员后“人才管理”下 7 个模块（任职资格、人才标准、人才评定、360、
 * 人才盘点、继任、IDP）都可见且有 ZZ 样例；HR 专员只拿到与其身份相符的入口；再跑一次种子不重复创建、不新增授权。
 * 种子只调公开租户接口（不绕过授权器、不直写表）。整个文件只种一次租户，再重跑一次核对幂等。
 */
import { and, eq, permissionAdmins, permissionGrants, users, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryProgress, seedDemo } from '../../apps/api/src/demo/seed.js';
import { actors, options, type Json } from './support/demo-seed.js';

const database = useTestDb();
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

type Actors = Awaited<ReturnType<typeof actors>>;
interface AppView {
  readonly app: string;
  readonly visible: boolean;
  readonly entryObjects: string[];
}

const R3_APPS = ['qualification', 'talent', 'evaluation', 'survey360', 'talent-review', 'succession', 'idp'] as const;

/** 账号 → 应有的 R3 入口（与 PR 描述里的对照表一致）。 */
const EXPECTED: Readonly<Record<'admin' | 'hr', readonly (typeof R3_APPS)[number][]>> = {
  admin: R3_APPS,
  hr: ['evaluation', 'survey360', 'succession'],
};

let user: Actors;
let tenantId: string;
const progress = memoryProgress();

const snapshotOf = async (key: 'admin' | 'hr' | 'employeeA') => {
  const body = await user.send(await user.persona(key), 'GET', '/api/tenant/permission/me/snapshot');
  return new Map((body.apps as AppView[]).map((app) => [app.app, app]));
};
const itemsOf = async (key: 'admin' | 'hr', path: string) => {
  const body = await user.send(await user.persona(key), 'GET', `/api/tenant/${path}`);
  return (body.items ?? []) as Json[];
};
const zz = (rows: Json[]) => rows.filter((row) => String(row.name).startsWith('ZZ'));

/** 每个模块的列表接口与“样例”的识别口径（继任记录没有名称字段，按手工来源的记录识别）。 */
const SAMPLES: readonly { module: string; path: string; pick: (rows: Json[]) => Json[] }[] = [
  { module: '任职资格 类别', path: 'qualification/categories?pageSize=200', pick: zz },
  { module: '人才标准 指标', path: 'talent/dimensions?pageSize=200', pick: zz },
  { module: '人才标准 人才标准', path: 'talent/criteria?pageSize=200', pick: zz },
  { module: '人才评定 活动', path: 'evaluation/activities?pageSize=200', pick: zz },
  { module: '360 活动', path: 'survey360/activities', pick: zz },
  { module: '人才盘点 项目', path: 'talent-review/projects?pageSize=200', pick: zz },
  {
    module: '继任 记录',
    path: 'succession/records?status=all&pageSize=200',
    pick: (rows) => rows.filter((r) => r.sourceKind === 'manual'),
  },
  { module: 'IDP 模板', path: 'idp/templates?pageSize=200', pick: zz },
  { module: 'IDP 计划', path: 'idp/plans?pageSize=200', pick: zz },
];

/** 逐个请求（不并发）：失败时不留下在途请求去撞已关闭的测试库。 */
const census = async () => {
  const samples: number[] = [];
  for (const sample of SAMPLES) samples.push(sample.pick(await itemsOf('admin', sample.path)).length);
  const grants: number[] = [];
  for (const key of ['admin', 'hr'] as const) {
    // 授权列表由系统管理员读取（HR 没有授权管理入口）
    const path = `/api/tenant/permission/grants?userId=${await user.persona(key)}`;
    grants.push((((await user.send(await user.persona('admin'), 'GET', path)).items ?? []) as Json[]).length);
  }
  return { samples, grants };
};

describe('AC-F198-demo-r3-seed 演示种子的 R3 权限与样例', () => {
  beforeAll(async () => {
    const created = await seedDemo(database().db, { ...options, progress });
    expect(created.created).toBe(true);
    tenantId = created.manifest.tenantId;
    user = await actors(database().db);
  });

  it('系统管理员的权限快照里 7 个 R3 应用都可见，且入口对象非空', async () => {
    const apps = await snapshotOf('admin');
    for (const app of EXPECTED.admin) {
      expect(apps.get(app)?.visible, `${app} 可见`).toBe(true);
      expect(apps.get(app)?.entryObjects.length, `${app} 入口对象`).toBeGreaterThan(0);
    }
  });

  it('系统管理员读各模块列表，每个都至少有 1 条 ZZ 样例', async () => {
    const admin = await user.persona('admin');
    for (const sample of SAMPLES) {
      const body = await user.send(admin, 'GET', `/api/tenant/${sample.path}`);
      expect(sample.pick((body.items ?? []) as Json[]).length, sample.module).toBeGreaterThanOrEqual(1);
    }
  });

  it('样例都停在合法的非终态：评定活动草稿、盘点项目新建、IDP 计划未开始', async () => {
    expect(zz(await itemsOf('admin', 'evaluation/activities?pageSize=200')).map((r) => r.status)).toEqual(['draft']);
    expect(zz(await itemsOf('admin', 'talent-review/projects?pageSize=200')).map((r) => r.status)).toEqual(['new']);
    expect(zz(await itemsOf('admin', 'idp/plans?pageSize=200')).map((r) => r.status)).toEqual(['not_started']);
    expect(zz(await itemsOf('admin', 'survey360/activities')).map((r) => r.status)).toEqual(['draft']);
  });

  it('HR 专员的 R3 入口与其身份一致，不该看到的入口看不到', async () => {
    const apps = await snapshotOf('hr');
    for (const app of R3_APPS) {
      const expected = EXPECTED.hr.includes(app);
      expect(apps.get(app)?.visible, `HR ${app}`).toBe(expected);
      expect(apps.get(app)!.entryObjects.length > 0, `HR ${app} 入口对象`).toBe(expected);
    }
    // 评定专员只含流程对象：评定活动（活动设置）不在入口里
    expect(apps.get('evaluation')!.entryObjects).not.toContain('TEvaluation.EvaluationActivity');
    // HR 的继任范围覆盖全部组织：能读到继任记录
    const records = await user.send(await user.persona('hr'), 'GET', '/api/tenant/succession/records?status=all');
    expect(records.hasDataPermission).toBe(true);
    expect((records.items as Json[]).length).toBeGreaterThanOrEqual(1);
  });

  it('反向：普通员工（无任何 R3 标准身份）的 R3 入口一个都看不到', async () => {
    const apps = await snapshotOf('employeeA');
    for (const app of R3_APPS) expect(apps.get(app)?.visible, `员工 ${app}`).toBe(false);
  });

  it('再跑一次种子：样例条数不变，没有新增授权行', async () => {
    const before = await census();
    const again = await seedDemo(database().db, { ...options, progress });
    expect(again.created).toBe(false);
    expect(await census()).toEqual(before);
  });

  /**
   * 审查第 1 轮 P2-1（F-474-5 #22/#23）：授权 / 管理员列表新增默认分页（50）后，演示种子的“先查后建”不能被截断——
   * 同一用户同一身份累计 ≥50 条撤销记录（有效授权排在后面）、管理员记录 ≥50 条时再跑种子，仍成功且不新增授权。
   */
  it('撤销记录与管理员记录都超过一页后再跑种子：不报 409，不新增授权 / 管理员', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z');
    const filler = 55;
    const counts = () =>
      withTenant(database().db, tenantId, async (tx) => ({
        grants: (await tx.select().from(permissionGrants).where(eq(permissionGrants.status, 'active'))).length,
        admins: (await tx.select().from(permissionAdmins).where(eq(permissionAdmins.status, 'active'))).length,
      }));
    const before = await counts();
    await withTenant(database().db, tenantId, async (tx) => {
      const active = await tx.select().from(permissionGrants).where(eq(permissionGrants.status, 'active'));
      for (const grant of active) {
        // 同一用户 × 同一身份的历史撤销记录，创建时间早于现有有效授权，排在列表前面
        await tx.insert(permissionGrants).values(
          Array.from({ length: filler }, () => ({
            tenantId,
            userId: grant.userId,
            profileId: grant.profileId,
            status: 'revoked' as const,
            createdAt: old,
            updatedAt: old,
          })),
        );
      }
    });
    const candidates = await withPlatform(database().db, (tx) => tx.select({ id: users.id }).from(users).limit(200));
    await withTenant(database().db, tenantId, async (tx) => {
      const held = new Set(
        (
          await tx
            .select()
            .from(permissionAdmins)
            .where(and(eq(permissionAdmins.role, 'audit_admin')))
        ).map((a) => a.userId),
      );
      const fillers = candidates.filter((c) => !held.has(c.id)).slice(0, filler);
      expect(fillers).toHaveLength(filler);
      await tx
        .insert(permissionAdmins)
        .values(fillers.map((c) => ({ tenantId, userId: c.id, role: 'audit_admin', createdAt: old, updatedAt: old })));
    });

    const again = await seedDemo(database().db, { ...options, progress });
    expect(again.created).toBe(false);
    const after = await counts();
    expect(after.grants).toBe(before.grants);
    expect(after.admins).toBe(before.admins + filler);
  });
});
