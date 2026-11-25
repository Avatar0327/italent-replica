/**
 * F-567（F-564 卡外遗留，与 F-564 P2-1 同型）：导入编辑行 / 导入预览对员工自助草稿的两项校验——
 * ①业务写范围复核（requireBusinessWriteScope）、②员工保存值策略（requireEmployeeTransferBusiness）——
 * 必须在同一个事务、基于同一次读取里完成。
 *
 * 修前：两项校验各开一个事务，中间目标可被改动：HR 在范围内的草稿，第①步放行后，经理失格（目标部门改挂到别处），
 *   第②步读到新版本就抛 403「员工调动的……」或策略 403，而此刻调用方的写范围已被收回，应是与不存在的单据一致的 404。
 * 修后：①②读同一份 REPEATABLE READ 快照；之后命令内的守卫仍按当前授权重过范围，范围外一律 404；预览不再读到第二个版本。
 * 时序确定性复现：mock requireBusinessWriteScope 标记“入口的范围复核已执行”，HR 请求走的库连接代理在承载它的事务结束后
 * 执行一次钩子（范围复核与策略校验之间的窗口；修后策略校验在同一事务内，钩子落在两项校验之后）。不靠 sleep、不靠行锁等待。
 * 失格用真实的组织改上级入口，范围收回用真实的管理员写入口。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ReplayGuard from '../../apps/api/src/modules/employment/replay-guard.js';
import { BASE, LATER, ok, scopedHr, selfWorld, snapshotOf } from './AC-TRF-F036S4-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const hooks = vi.hoisted(() => ({
  /** 入口的业务写范围复核、且承载它的事务结束后执行一次。 */
  afterEntryScope: undefined as undefined | (() => Promise<void>),
  entryScopeSeen: false,
  fired: 0,
}));
vi.mock('../../apps/api/src/modules/employment/replay-guard.js', async (importOriginal) => {
  const original = await importOriginal<typeof ReplayGuard>();
  return {
    ...original,
    requireBusinessWriteScope: async (...args: Parameters<typeof original.requireBusinessWriteScope>) => {
      const value = await original.requireBusinessWriteScope(...args);
      // 只记请求里第一次写范围复核（入口的）；命令内守卫与钩子里别的请求不再触发。
      if (hooks.afterEntryScope && !hooks.entryScopeSeen) hooks.entryScopeSeen = true;
      return value;
    },
  };
});

const database = useTestDb();
afterEach(() => {
  hooks.afterEntryScope = undefined;
  hooks.entryScopeSeen = false;
  hooks.fired = 0;
});

/** 员工本人建草稿（目标部门 T 是原部门的下级，直线经理在原部门，合格候选）；一名范围含 T 的部门 HR 导入编辑它。 */
async function world(label: string) {
  const s = await selfWorld(database().db, `${label}-${uniqueSuffix()}`);
  await ok(
    await s.w.request(s.w.hr.id, 'PUT', `${BASE}/transfers/settings`, {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: false, autoPopulate: false },
    }),
  );
  const manager = await s.employee('合成直线经理');
  const person = await s.employee('合成员工');
  const target = await s.w.org('合成目标部门', s.source);
  const elsewhere = await s.w.org('合成别处部门');
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
  // HR 的请求走计数代理：承载入口范围复核的事务一结束，就执行 hooks.afterEntryScope。
  const stepped = new Proxy(s.w.db, {
    get(origin, prop) {
      if (prop !== 'transaction') return Reflect.get(origin, prop, origin);
      return async (...a: Parameters<typeof origin.transaction>) => {
        const result = await origin.transaction(...a);
        const hook = hooks.afterEntryScope;
        if (hook && hooks.entryScopeSeen) {
          hooks.afterEntryScope = undefined;
          hooks.entryScopeSeen = false;
          hooks.fired += 1;
          await hook();
        }
        return result;
      };
    },
  });
  const api = tenantApi(stepped, { authorize: undefined, clock: s.w.clock });
  const employeeRevision = async () =>
    (
      await s.w.json<{ revision: number }>(
        await s.w.request(s.w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}`),
      )
    ).revision;
  const call = async (path: 'import' | 'import/forward-update-preview', key: string) => {
    const shown = await s.show(draft.id);
    return api.request('POST', `${BASE}/employees/${person.employeeId}/${path}`, {
      ...s.w.as(hr.userId),
      ifMatch: await employeeRevision(),
      idempotencyKey: key,
      body: {
        items: [{ operation: 'edit', id: draft.id, revision: shown.revision, patch: { effectiveDate: LATER } }],
      },
    });
  };
  /** 目标部门改挂到别处：经理不再在目标部门的上级链里（保存值里的直线经理失格）。 */
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
  return {
    s,
    draft,
    hr,
    disqualifyManager,
    importEdit: (key = `imp-${uniqueSuffix()}`) => call('import', key),
    preview: () => call('import/forward-update-preview', `prv-${uniqueSuffix()}`),
  };
}

const code = async (response: Response) =>
  ((await response.clone().json()) as { error?: { code?: string } }).error?.code;

describe('AC-TRF-F567 导入编辑行：写范围复核与员工保存值策略读同一份快照', () => {
  it('①两项校验之间经理失格且 HR 范围被收回 → 404 NOT_FOUND（不是 403），草稿不变', async () => {
    const w = await world('f567-import-drift');
    const before = await snapshotOf(w.s, w.draft.id);
    hooks.afterEntryScope = async () => {
      await w.disqualifyManager();
      await w.hr.revokeScope();
    };
    const response = await w.importEdit();
    expect(hooks.fired, '钩子没有在入口范围复核之后触发，夹具没有走到目标窗口').toBe(1);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await code(response)).toBe('NOT_FOUND');
    expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
  });

  it('②对照：两步之间钩子不改任何东西 → 两项校验都通过，命令拒绝草稿（409 只能编辑有效任职记录），草稿不变', async () => {
    const w = await world('f567-import-legal');
    const before = await snapshotOf(w.s, w.draft.id);
    hooks.afterEntryScope = async () => undefined;
    const response = await w.importEdit();
    expect(hooks.fired).toBe(1);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await code(response)).toBe('CONFLICT');
    expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
  });

  it('③对照：入口前经理已失格、范围仍在 → 仍是策略校验的 403，草稿不变', async () => {
    const w = await world('f567-import-policy');
    const before = await snapshotOf(w.s, w.draft.id);
    await w.disqualifyManager();
    const response = await w.importEdit();
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await code(response)).toBe('FORBIDDEN');
    expect(await snapshotOf(w.s, w.draft.id)).toEqual(before);
  });

  it('④对照：入口前范围已收回且经理失格 → 404（范围复核先于策略校验）', async () => {
    const w = await world('f567-import-scope-first');
    await w.disqualifyManager();
    await w.hr.revokeScope();
    const response = await w.importEdit();
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await code(response)).toBe('NOT_FOUND');
  });
});

describe('AC-TRF-F567 导入预览：写范围复核与员工保存值策略读同一份快照', () => {
  it('⑤两项校验之间经理失格 → 按同一次读取放行，与无漂移的对照一致（409 只能预览有效任职记录），不是 403', async () => {
    const w = await world('f567-preview-drift');
    hooks.afterEntryScope = () => w.disqualifyManager();
    const response = await w.preview();
    expect(hooks.fired, '钩子没有在入口范围复核之后触发，夹具没有走到目标窗口').toBe(1);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await code(response)).toBe('CONFLICT');
  });

  it('⑥对照：预览前经理已失格 → 仍是策略校验的 403', async () => {
    const w = await world('f567-preview-policy');
    await w.disqualifyManager();
    const response = await w.preview();
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await code(response)).toBe('FORBIDDEN');
  });

  it('⑦对照：钩子不改任何东西 → 夹具走到窗口，两项校验通过，预览按草稿拒绝（409）', async () => {
    const w = await world('f567-preview-legal');
    hooks.afterEntryScope = async () => undefined;
    const response = await w.preview();
    expect(hooks.fired).toBe(1);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await code(response)).toBe('CONFLICT');
  });
});
