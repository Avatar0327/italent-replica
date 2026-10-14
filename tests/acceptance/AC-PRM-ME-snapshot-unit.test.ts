/** 权限快照的纯函数与目录守卫（DEC-469）：应用目录与前端一致、对象编码全部已登记、数据范围摘要的三态与截断。 */
import '@italent/api'; // 各模块在加载时登记自己的对象
import { APP_IDS, APP_OBJECT_DIRECTORY } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import {
  fitScopeToBudget,
  SNAPSHOT_ORG_LIMIT,
  summarizeScope,
  type ScopeSummary,
} from '../../apps/api/src/modules/permission/me-snapshot.js';
import { menuObjects } from '../../apps/web/src/foundation/permission-snapshot.js';
import { APP_ROUTES } from '../../apps/web/src/foundation/routes.js';

const base = { personIds: [], all: false, hasDataPermission: true } as const;
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

describe('应用 → 菜单对象目录（packages/domain）', () => {
  it('应用键与前端路由一一对应，对象顺序与前端 menuObjects 完全一致', () => {
    expect([...APP_IDS]).toEqual(APP_ROUTES.map((route) => route.id));
    for (const route of APP_ROUTES) expect([...APP_OBJECT_DIRECTORY[route.id]], route.id).toEqual(menuObjects(route));
  });

  it('目录里没有重复编码，且每个编码都已登记到对象目录（除 manager 无对象）', () => {
    // 其他模块的对象在模块加载时登记；这里加载完整 API 后目录应已齐全
    const all = APP_IDS.flatMap((app) => APP_OBJECT_DIRECTORY[app]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((code) => !objectCatalog.get(code))).toEqual([]);
    expect(APP_OBJECT_DIRECTORY.manager).toEqual([]);
  });
});

describe('summarizeScope 数据范围摘要', () => {
  it('all → all；无任何数据权限 → none', () => {
    expect(summarizeScope('org', { ...base, orgIds: [], all: true })).toEqual({
      app: 'org',
      status: 'all',
      organizationIds: [],
      truncated: false,
    });
    expect(summarizeScope('org', { ...base, orgIds: ids(3), hasDataPermission: false })).toMatchObject({
      status: 'none',
      organizationIds: [],
    });
  });

  it('limited：合并各项的组织并去重；按人员 / 汇报关系的项没有组织集合也是 limited', () => {
    const [a, b, c] = ids(3) as [string, string, string];
    const scope = {
      ...base,
      orgIds: [a, b],
      terms: [
        { dimension: 'management' as const, orgIds: [a, b], personIds: [] },
        { dimension: 'organization' as const, orgIds: [b, c], personIds: [] },
      ],
    };
    expect(summarizeScope('job', scope)).toEqual({
      app: 'job',
      status: 'limited',
      organizationIds: [a, b, c],
      truncated: false,
    });
    expect(
      summarizeScope('staff', {
        ...base,
        orgIds: [],
        terms: [{ dimension: 'reporting', orgIds: [], personIds: [] }],
      }),
    ).toMatchObject({ status: 'limited', organizationIds: [], truncated: false });
  });

  it(`超过 ${SNAPSHOT_ORG_LIMIT} 个组织时截断并置 truncated`, () => {
    const exact = summarizeScope('org', { ...base, orgIds: ids(SNAPSHOT_ORG_LIMIT) });
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.organizationIds).toHaveLength(SNAPSHOT_ORG_LIMIT);
    const over = summarizeScope('org', { ...base, orgIds: ids(SNAPSHOT_ORG_LIMIT + 1) });
    expect(over.truncated).toBe(true);
    expect(over.organizationIds).toEqual(ids(SNAPSHOT_ORG_LIMIT));
  });
});

describe('fitScopeToBudget 整包字节预算', () => {
  const ID_BYTES = JSON.stringify(ids(1)[0]).length + 1;
  const limited = (app: ScopeSummary['app'], n: number, truncated = false): ScopeSummary => ({
    app,
    status: 'limited',
    organizationIds: ids(n),
    truncated,
  });

  it('预算充足时原样返回；all / none 不受影响', () => {
    const input: ScopeSummary[] = [
      limited('org', 5),
      { app: 'job', status: 'all', organizationIds: [], truncated: false },
      { app: 'staff', status: 'none', organizationIds: [], truncated: false },
    ];
    expect(fitScopeToBudget(input, 5 * ID_BYTES)).toEqual(input);
  });

  it('预算不足：轮流分配、同一组织在各应用重复计入，被截短的应用 truncated=true 且仍是 limited', () => {
    const input = [limited('org', 10), limited('job', 10), limited('staff', 2)];
    const result = fitScopeToBudget(input, 8 * ID_BYTES);
    expect(result.map((r) => r.organizationIds.length)).toEqual([3, 3, 2]);
    expect(result.map((r) => r.truncated)).toEqual([true, true, false]);
    expect(result.every((r) => r.status === 'limited')).toBe(true);
    expect(result[0]!.organizationIds).toEqual(ids(3));
    expect(result[1]!.organizationIds).toEqual(ids(3));
  });

  it('预算为 0 或为负：全部省略并置 truncated；已有 truncated 保持', () => {
    for (const budget of [0, -10]) {
      const result = fitScopeToBudget([limited('org', 3), limited('job', 0), limited('idp', 4, true)], budget);
      expect(result.map((r) => [r.organizationIds.length, r.truncated])).toEqual([
        [0, true],
        [0, false],
        [0, true],
      ]);
    }
  });

  it('已被单项 200 上限截断的应用，即使预算足够也保持 truncated=true', () => {
    const [result] = fitScopeToBudget([limited('org', SNAPSHOT_ORG_LIMIT, true)], 1_000_000);
    expect(result).toMatchObject({ truncated: true });
    expect(result!.organizationIds).toHaveLength(SNAPSHOT_ORG_LIMIT);
  });
});
