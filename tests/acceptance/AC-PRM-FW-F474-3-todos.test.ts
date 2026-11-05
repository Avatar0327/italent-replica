import { routeManifest, type ManifestRoute, type RoutePolicy } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as disclosure from '../../apps/api/src/modules/approval/disclosure.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { objectFacts } from './support/route-policy/objects.js';
import { declaredPerms } from './support/route-policy/perms.js';
import { scanPrimitives } from './support/route-policy/primitives.js';
import { checkRequired } from './support/route-policy/required.js';
import { APPROVAL } from './support/route-policy/required/approval.js';
import {
  closureText,
  indexSources,
  matchRegistrations,
  moduleDirs,
  scanRegistrations,
} from './support/route-policy/scan.js';

const database = useTestDb();
const key = 'GET /api/tenant/approval/todos';
const path = '/api/tenant/approval/todos';
let route: ManifestRoute;
let observed: ObservedContract;
beforeAll(() => {
  route = routeManifest(tenantApi(database().db).app).declared.find((r) => `${r.method} ${r.path}` === key)!;
  const index = indexSources();
  const { module, dirs } = moduleDirs(path);
  const hits = matchRegistrations(scanRegistrations(index), 'GET', '/todos', dirs);
  expect(hits).toHaveLength(1);
  const deep = closureText(index, hits[0]!, 6);
  const near = closureText(index, hits[0]!, 3);
  const objects = objectFacts(index, near, module, dirs);
  // 每次从真实源码探测权限事实，不能靠覆盖冻结文件让声明断言变绿。
  observed = {
    routes: {
      [key]: {
        ...readFrozenContract()!.routes[key]!,
        primitives: {
          ...scanPrimitives({ deep, near }, 'GET', module, path),
          ...(objects.length ? { objectOp: objects } : {}),
        },
      },
    },
    domains: {},
  };
});
afterEach(() => vi.restoreAllMocks());

function branch(predicate: string): RoutePolicy {
  if (route.policy.kind !== 'any') throw new Error('待办应登记互斥的本人关系备选');
  const selected = route.policy.of.find((p) => p.kind === 'own' && p.predicate === predicate);
  if (!selected) throw new Error(`缺少本人关系 ${predicate}`);
  return { ...selected, optional: route.policy.optional };
}

describe('AC-PRM-FW-F474-3 待办备选关系与摘要披露边界', () => {
  it.each([
    ['无 view', 'approval.recipient'],
    ['view=pending', 'approval.recipient'],
    ['view=completed', 'approval.initiatedOrParticipated'],
    ['view=initiated', 'approval.initiatedOrParticipated'],
  ])('%s 只要求对应本人关系，不要求另一备选同时成立', (_view, predicate) => {
    const policy = branch(predicate);
    expect([...declaredPerms(policy).alternatives[0]!.keys()]).toEqual([`own:${predicate}`]);
    expect(checkRequired(APPROVAL, observed, [{ ...route, policy }])).toEqual([]);
  });

  it('卡片摘要不计算详情动作，剩余准入 / 披露事实全部有正式义务承接', () => {
    expect(observed.routes[key]!.primitives['relation']).not.toContain('retrievable（retrievableTask）');
    expect(checkRequired(APPROVAL, observed, [route])).toEqual([]);
  });

  it('无 view 只读本人 pending；历史先披露过滤再分页，不能以事后投影掩盖总数', async () => {
    const w = await approvalWorld(database().db, 'f474-policy');
    const s = await transferScene(w);
    await w.publishedProcess({
      hideRecordsFromInitiator: true,
      nodes: [
        { key: 'first', approver: { type: 'department', value: 'latest_record_department_head' }, hideRecords: true },
        { key: 'next', approver: { type: 'department', value: 'record_department_head' } },
      ],
    });
    const instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const read = vi.spyOn(disclosure, 'readDetail');
    const legacy = await w.json<{ items: { instanceId: string }[] }>(await w.request(s.outHead.userId, 'GET', path));
    expect(legacy.items.map((item) => item.instanceId)).toEqual([instance.id]);
    expect((await w.json<{ items: unknown[] }>(await w.request(w.hr.id, 'GET', path))).items).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    await w.json(await w.taskAction(s.outHead.userId, task.id, 'approve', instance.revision));
    read.mockClear();
    for (const [view, user] of [
      ['initiated', w.hr.id],
      ['completed', s.outHead.userId],
    ] as const) {
      const history = await w.json<{ items: unknown[]; total: number; categories: { count: number }[] }>(
        await w.request(user, 'GET', `${path}?view=${view}&pageSize=1`),
      );
      expect(history).toMatchObject({ items: [], total: 0 });
      expect(history.categories.every((c) => c.count === 0)).toBe(true);
    }
    // 隐藏实例根本不会进入逐条投影，证明过滤发生在页与计数之前。
    expect(read).not.toHaveBeenCalled();
  });
});
