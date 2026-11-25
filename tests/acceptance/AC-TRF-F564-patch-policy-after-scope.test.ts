/**
 * F-564（F-563 开发方发现的同型遗留）：草稿 PATCH 的策略校验（requireDraftEditWrite，内含员工自助单据保存值校验
 * requireEmployeeTransferBusiness）必须排在命令事务内的业务写范围复核（requireBusinessWriteScope）之后。
 *
 * 同请求时序：HR 在入口被放行（范围内、直线经理仍是候选）→ 入口到命令事务之间，业务范围被收回，且单据上保存的直线经理
 * 已不在新部门及其上级链的在职员工里（目标部门改挂到别处）→ 命令事务内复核。
 *   修前：同单写入口守卫里策略校验先抛 403，调用方能借此区分“经理校验失败”与“范围外 404”；
 *   修后：范围外一律 404「任职业务不存在」，与不存在的单据不可区分，策略校验一次都不会被碰到。
 * 时序用 runCommand 前置钩子在“入口之后、命令事务之前”（事务外）制造，PGlite 与 PostgreSQL 都跑，不依赖行锁等待。
 * 范围收回用真实的管理员写入口（scopedHr.revokeScope），经理失格用真实的组织改上级入口（目标部门改挂到别处）。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { BASE, LATER, ok, scopedHr, selfWorld, snapshotOf } from './AC-TRF-F036S4-support.js';
import { uniqueSuffix } from './support/unique.js';

/** beforeCommand：命令（runCommand）开始前执行一次（此刻入口已放行、命令事务还没开）；每次武装只触发一次。 */
const hooks = vi.hoisted(() => ({ beforeCommand: undefined as undefined | (() => Promise<void>), fired: 0 }));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<typeof Commands>();
  return {
    ...original,
    runCommand: async (...args: Parameters<typeof original.runCommand>) => {
      const hook = hooks.beforeCommand;
      hooks.beforeCommand = undefined;
      if (hook) {
        hooks.fired += 1;
        await hook();
      }
      return original.runCommand(...args);
    },
  };
});

const database = useTestDb();
afterEach(() => {
  hooks.beforeCommand = undefined;
  hooks.fired = 0;
});

/**
 * 员工本人建草稿，目标部门 T 是原部门的下级，直线经理在原部门（T 的上级链里，合格候选）；一名部门范围 HR（范围含 T）
 * 在入口获准 PATCH。把 T 改挂到别处（真实组织改上级入口）后，T 的上级链不再含经理：保存值里的直线经理失格，
 * 而经理本人与草稿原样不动。HR 的 PATCH 只改生效日，不带经理字段，策略校验靠的是单据上保存的经理。
 */
async function world(label: string, unrestrictTargetDepartment: boolean) {
  const s = await selfWorld(database().db, `${label}-${uniqueSuffix()}`);
  await ok(
    await s.w.request(s.w.hr.id, 'PUT', `${BASE}/transfers/settings`, {
      ifMatch: 0,
      body: { unrestrictTargetDepartment, autoPopulate: false },
    }),
  );
  const manager = await s.employee('合成直线经理');
  const person = await s.employee('合成员工');
  const target = await s.w.org('合成目标部门', s.source);
  const elsewhere = await s.w.org('合成别处部门');
  // 员工本人的数据范围加上目标部门：目标部门例外关闭时，员工只能向自己范围内的部门发起调动。
  await ok(
    await s.admin.api.request('PUT', `/api/tenant/permission/scopes/${person.userId}/TenantBase`, {
      ...s.admin.asAdmin,
      ifMatch: 1,
      body: {
        kind: 'org_range',
        orgRanges: [s.source, target].map((orgId) => ({ orgId, includeDescendants: false })),
      },
    }),
  );
  const draft = await s.draftOf(person, { departmentId: target, directManagerId: manager.employeeId });
  const hr = await scopedHr(s, [target]);
  const edit = async (key: string, revision?: number) =>
    s.patch(hr, draft.id, { effectiveDate: LATER }, { key, revision });
  /** 目标部门改挂到别处：经理不再在目标部门的上级链里。 */
  const disqualifyManager = async () => {
    const org = await s.w.json<{ revision: number }>(
      await s.w.request(s.w.hr.id, 'GET', `/api/tenant/org/organizations/${target}`),
    );
    await ok(
      await s.w.request(s.w.hr.id, 'PATCH', `/api/tenant/org/organizations/${target}`, {
        ifMatch: org.revision,
        body: { parents: { admin: { parentId: elsewhere } }, effectiveDate: '2026-10-01', addEmployment: false },
      }),
    );
  };
  return { s, draft, hr, edit, disqualifyManager };
}

const code = async (response: Response) =>
  ((await response.clone().json()) as { error?: { code?: string } }).error?.code;

/**
 * 目标部门例外（“不限制目标部门”）关闭时，同单来源复核（transferBusinessContext）对范围外的单据不抛 404、原样放行，
 * 范围外的 404 只由命令内的 requireBusinessWriteScope 给出——修前策略校验正好排在它前面（关闭 = 本任务的红场景）。
 * 开启时同单来源复核自己就会 404，两种设置下的答案必须一致。
 */
describe.each([false, true])(
  'AC-TRF-F564 草稿 PATCH 的策略校验排在业务写范围复核之后（不限制目标部门 = %s）',
  (unrestricted) => {
    it('①首次 PATCH：范围已收回且经理已失格 → 404 NOT_FOUND（不是 403），零写入', async () => {
      const w = await world(`f564-first-${unrestricted}`, unrestricted);
      const before = await snapshotOf(w.s, w.draft.id);
      hooks.beforeCommand = async () => {
        await w.disqualifyManager();
        await w.hr.revokeScope();
      };
      const response = await w.edit(`k1-${uniqueSuffix()}`);
      expect(hooks.fired, '钩子没有在入口之后、命令之前触发，夹具没有走到目标窗口').toBe(1);
      expect(response.status, await response.clone().text()).toBe(404);
      expect(await code(response)).toBe('NOT_FOUND');
      expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
    });

    it('②同键重放：首次 PATCH 已成功，之后范围收回且经理失格 → 重放 404，不是 403，也不回缓存回执', async () => {
      const w = await world(`f564-replay-${unrestricted}`, unrestricted);
      const key = `k2-${uniqueSuffix()}`;
      const { revision } = await w.s.show(w.draft.id);
      const first = await w.edit(key, revision);
      expect(first.status, await first.clone().text()).toBe(200);
      hooks.beforeCommand = async () => {
        await w.disqualifyManager();
        await w.hr.revokeScope();
      };
      const replay = await w.edit(key, revision);
      expect(hooks.fired).toBe(1);
      expect(replay.status, await replay.clone().text()).toBe(404);
      expect(await code(replay)).toBe('NOT_FOUND');
    });

    it('③对照：范围没收回、经理已失格 → 仍是策略校验的 403，单据不变', async () => {
      const w = await world(`f564-policy-${unrestricted}`, unrestricted);
      const before = await snapshotOf(w.s, w.draft.id);
      hooks.beforeCommand = async () => {
        await w.disqualifyManager();
      };
      const response = await w.edit(`k3-${uniqueSuffix()}`);
      expect(hooks.fired).toBe(1);
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await code(response)).toBe('FORBIDDEN');
      expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
    });

    it('④对照：范围内、经理仍合格 → 合法 PATCH 200，生效日已改', async () => {
      const w = await world(`f564-legal-${unrestricted}`, unrestricted);
      hooks.beforeCommand = async () => undefined;
      const response = await w.edit(`k4-${uniqueSuffix()}`);
      expect(hooks.fired).toBe(1);
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await w.s.show(w.draft.id)).effectiveDate).toBe(LATER);
    });

    it('⑤对照：只收回范围、经理仍合格 → 404（范围外与不存在同一个答案）', async () => {
      const w = await world(`f564-scope-only-${unrestricted}`, unrestricted);
      hooks.beforeCommand = async () => {
        await w.hr.revokeScope();
      };
      const response = await w.edit(`k5-${uniqueSuffix()}`);
      expect(hooks.fired).toBe(1);
      expect(response.status, await response.clone().text()).toBe(404);
      expect(await code(response)).toBe('NOT_FOUND');
    });

    it('⑥对照：入口前就已收回范围且经理失格 → 入口直接 404（入口本来就先复核范围）', async () => {
      const w = await world(`f564-entry-${unrestricted}`, unrestricted);
      const before = await snapshotOf(w.s, w.draft.id);
      await w.disqualifyManager();
      await w.hr.revokeScope();
      const response = await w.edit(`k6-${uniqueSuffix()}`, (await w.s.show(w.draft.id)).revision);
      expect(response.status, await response.clone().text()).toBe(404);
      expect(await code(response)).toBe('NOT_FOUND');
      expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
    });
  },
);
