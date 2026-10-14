/** C1 / F-039：个人偏好与统计的源码闭包必须分别反映各自授权要求。 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { successionWorld, type SuccessionWorld } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';
import { scanPrimitives } from './support/route-policy/primitives.js';
import {
  closureText,
  indexSources,
  matchRegistrations,
  moduleDirs,
  scanRegistrations,
} from './support/route-policy/scan.js';

const index = indexSources();
const registrations = scanRegistrations(index);
const db = useTestDb();
let w: SuccessionWorld;
beforeAll(async () => {
  w = await successionWorld(db().db, 'sc-map-route-policy');
});
function facts(method: string, path: string) {
  const { module, dirs } = moduleDirs(path);
  const hits = matchRegistrations(registrations, method, path, dirs);
  expect(hits).toHaveLength(1);
  return scanPrimitives(
    {
      deep: hits.map((hit) => closureText(index, hit, 6)).join('\n'),
      near: hits.map((hit) => closureText(index, hit, 3)).join('\n'),
    },
    method,
    module,
    path,
  );
}

describe('AC-SC-map-route-policy 独立授权入口', () => {
  it('个人偏好源码不引入 computeStats 的按钮事实', () => {
    expect(facts('PUT', '/api/tenant/succession/maps/:kind/preferences').button ?? []).toEqual([]);
  });
  it('统计源码仍包含按钮校验与命令台账', () => {
    const observed = facts('POST', '/api/tenant/succession/maps/org/compute-stats');
    expect(observed.button).toContain('button()');
    expect(observed.command).toContain('runCommand / runWrite');
  });
  it('真实请求只有查看权可保存本人偏好；无统计按钮时计算请求仍拒绝', async () => {
    const api = tenantApi(w.db, { authorize: (q) => q.action !== 'object.button' });
    const caller = { tenant: w.tenant.id, user: w.user.id, ifMatch: 0 };
    const saved = await api.request('PUT', '/api/tenant/succession/maps/position/preferences', {
      ...caller,
      body: {
        rootOrgId: null,
        depth: 3,
        hiddenOrgIds: [],
        showKeyPositions: false,
        showPositionsWithoutSuccessor: true,
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(
      (
        await api.request('POST', '/api/tenant/succession/maps/org/compute-stats', {
          ...caller,
          body: {},
        })
      ).status,
    ).toBe(403);
  });
});
