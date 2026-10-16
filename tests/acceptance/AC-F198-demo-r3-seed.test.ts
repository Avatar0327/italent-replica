/**
 * F-198 演示种子补 R3 权限与样例数据：切到系统管理员后“人才管理”下 7 个模块（任职资格、人才标准、人才评定、360、
 * 人才盘点、继任、IDP）都可见且有 ZZ 样例；HR 专员只拿到与其身份相符的入口；再跑一次种子不重复创建、不新增授权。
 * 种子只调公开租户接口（不绕过授权器、不直写表）。整个文件只种一次租户，再重跑一次核对幂等。
 */
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
const progress = memoryProgress();

const snapshotOf = async (key: 'admin' | 'hr') => {
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

const census = async () => ({
  samples: await Promise.all(SAMPLES.map(async (s) => s.pick(await itemsOf('admin', s.path)).length)),
  grants: await Promise.all(
    (['admin', 'hr'] as const).map(async (key) => {
      const body = await user.send(
        await user.persona(key),
        'GET',
        `/api/tenant/permission/grants?userId=${await user.persona(key)}`,
      );
      return ((body.items ?? []) as Json[]).length;
    }),
  ),
});

describe('AC-F198-demo-r3-seed 演示种子的 R3 权限与样例', () => {
  let first: Awaited<ReturnType<typeof census>>;

  beforeAll(async () => {
    const created = await seedDemo(database().db, { ...options, progress });
    expect(created.created).toBe(true);
    user = await actors(database().db);
    first = await census();
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

  it('再跑一次种子：样例条数不变，没有新增授权行', async () => {
    const again = await seedDemo(database().db, { ...options, progress });
    expect(again.created).toBe(false);
    expect(await census()).toEqual(first);
  });
});
