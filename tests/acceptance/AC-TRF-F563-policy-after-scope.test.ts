/**
 * F-563（F-036 S6 第 3 轮 Sol 范围外 P2）：员工自助调动单的保存值策略校验（requireEmployeeTransferBusiness）
 * 必须排在命令事务内的业务写范围复核（requireBusinessWriteScope）之后。
 *
 * 同请求时序：HR 在入口被放行（范围内、直线经理仍是候选）→ 入口到命令事务之间，业务范围被收回，且单据上保存的直线经理
 * 已不在新部门及其上级链的在职员工里（经理调去别的部门）→ 命令事务内复核。
 *   修前：策略校验先抛 403，调用方能借此区分“经理校验失败”与“范围外 404”；
 *   修后：范围外一律 404「任职业务不存在」，与不存在的单据不可区分，策略校验一次都不会被碰到。
 * 时序用 runCommand 前置钩子在“入口之后、命令事务之前”（事务外）制造，PGlite 与 PostgreSQL 都跑，不依赖行锁等待。
 * 范围收回用真实的管理员写入口（scopedHr.revokeScope），经理失格用真实的 HR 改任职入口（hrEditCurrent）。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { BASE, ok, scopedHr, selfWorld, snapshotOf } from './AC-TRF-F036S4-support.js';
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
 * 在入口获准提交。把 T 改挂到别处（真实组织改上级入口）后，T 的上级链不再含经理：保存值里的直线经理失格，
 * 而经理本人与草稿原样不动（改经理任职会触发联动清空下属的经理，那样策略校验根本不会触发）。
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
  const submit = async (key: string) => s.submit(hr, draft.id, { key });
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
  return { s, draft, hr, submit, disqualifyManager };
}

const code = async (response: Response) =>
  ((await response.clone().json()) as { error?: { code?: string } }).error?.code;

/**
 * 目标部门例外（“不限制目标部门”）关闭时，同单来源复核（transferBusinessContext）对范围外的单据不抛 404、原样放行，
 * 范围外的 404 只由命令内的 requireBusinessWriteScope 给出——修前策略校验正好排在它前面（关闭 = 本任务的红场景）。
 * 开启时同单来源复核自己就会 404，两种设置下的答案必须一致。
 */
describe.each([false, true])(
  'AC-TRF-F563 员工自助单据的保存值策略校验排在业务写范围复核之后（不限制目标部门 = %s）',
  (unrestricted) => {
    it('①首次提交：范围已收回且经理已失格 → 404 NOT_FOUND（不是 403），零写入', async () => {
      const w = await world(`f563-first-${unrestricted}`, unrestricted);
      const before = await snapshotOf(w.s, w.draft.id);
      hooks.beforeCommand = async () => {
        await w.disqualifyManager();
        await w.hr.revokeScope();
      };
      const response = await w.submit(`k1-${uniqueSuffix()}`);
      expect(hooks.fired, '钩子没有在入口之后、命令之前触发，夹具没有走到目标窗口').toBe(1);
      expect(response.status, await response.clone().text()).toBe(404);
      expect(await code(response)).toBe('NOT_FOUND');
      expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
      expect((await w.s.show(w.draft.id)).status).toBe('draft');
    });

    it('②同键重放：首次提交已成功，之后范围收回且经理失格 → 重放 404，不是 403，也不回缓存回执', async () => {
      const w = await world(`f563-replay-${unrestricted}`, unrestricted);
      const key = `k2-${uniqueSuffix()}`;
      const { revision } = await w.s.show(w.draft.id);
      const first = await w.s.submit(w.hr, w.draft.id, { revision, key });
      expect(first.status, await first.clone().text()).toBe(200);
      hooks.beforeCommand = async () => {
        await w.disqualifyManager();
        await w.hr.revokeScope();
      };
      const replay = await w.s.submit(w.hr, w.draft.id, { revision, key });
      expect(hooks.fired).toBe(1);
      expect(replay.status, await replay.clone().text()).toBe(404);
      expect(await code(replay)).toBe('NOT_FOUND');
    });

    it('③对照：范围没收回、经理已失格 → 仍是策略校验的 403，单据不变', async () => {
      const w = await world(`f563-policy-${unrestricted}`, unrestricted);
      const before = await snapshotOf(w.s, w.draft.id);
      hooks.beforeCommand = async () => {
        await w.disqualifyManager();
      };
      const response = await w.submit(`k3-${uniqueSuffix()}`);
      expect(hooks.fired).toBe(1);
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await code(response)).toBe('FORBIDDEN');
      expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
    });

    it('④对照：范围内、经理仍合格 → 合法提交 200，单据进入审批', async () => {
      const w = await world(`f563-legal-${unrestricted}`, unrestricted);
      hooks.beforeCommand = async () => undefined;
      const response = await w.submit(`k4-${uniqueSuffix()}`);
      expect(hooks.fired).toBe(1);
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await w.s.show(w.draft.id)).status).toBe('in_review');
    });

    it('⑤对照：只收回范围、经理仍合格 → 404（范围外与不存在同一个答案）', async () => {
      const w = await world(`f563-scope-only-${unrestricted}`, unrestricted);
      hooks.beforeCommand = async () => {
        await w.hr.revokeScope();
      };
      const response = await w.submit(`k5-${uniqueSuffix()}`);
      expect(hooks.fired).toBe(1);
      expect(response.status, await response.clone().text()).toBe(404);
      expect(await code(response)).toBe('NOT_FOUND');
    });
  },
);
