/** C1 / F-039：个人偏好与统计的源码闭包必须分别反映各自授权要求。 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { successionWorld, type SuccessionWorld } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';
import { EVIDENCE_SCAN_TIMEOUT_MS } from './support/route-policy/evidence-timeout.js';
import { scanPrimitives } from './support/route-policy/primitives.js';
import {
  closureText,
  indexSources,
  matchRegistrations,
  moduleDirs,
  scanRegistrations,
} from './support/route-policy/scan.js';

// F-515：全树 scanRegistrations 实测约 10 秒（indexSources 约 1 秒）。放在模块顶层会落在收集阶段，
// 不受用例超时约束；改成首次调用 facts() 时才算，让成本落进带 EVIDENCE_SCAN_TIMEOUT_MS 的用例（DEC-881）。
let scanned: { index: ReturnType<typeof indexSources>; registrations: ReturnType<typeof scanRegistrations> };
function scanOnce() {
  if (!scanned) {
    const index = indexSources();
    scanned = { index, registrations: scanRegistrations(index) };
  }
  return scanned;
}
const db = useTestDb();
let w: SuccessionWorld;
beforeAll(async () => {
  w = await successionWorld(db().db, 'sc-map-route-policy');
});
function facts(method: string, path: string) {
  const { index, registrations } = scanOnce();
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
  // 这两条都会触发首次扫描，按 -t 单跑任一条时成本都落在它身上，所以都放宽（沿用 F-513 c992a5723 的做法）。
  it(
    '个人偏好源码不引入 computeStats 的按钮事实',
    () => {
      expect(facts('PUT', '/api/tenant/succession/maps/:kind/preferences').button ?? []).toEqual([]);
    },
    EVIDENCE_SCAN_TIMEOUT_MS,
  );
  it(
    '统计源码仍包含按钮校验与命令台账',
    () => {
      const observed = facts('POST', '/api/tenant/succession/maps/org/compute-stats');
      expect(observed.button).toContain('button()');
      expect(observed.command).toContain('runCommand / runWrite');
    },
    EVIDENCE_SCAN_TIMEOUT_MS,
  );
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
