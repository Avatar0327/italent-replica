/** AC-SC-07 / F-039：事务内的健康度查看权复核也必须由义务表承接。 */
import { routeManifest } from '@italent/api';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { checkRequired } from './support/route-policy/required.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import { tenantApi } from './support/tenant-api.js';

let handle: Awaited<ReturnType<typeof createTestDb>>;
// DEC-452：与 F-039 入口一致，完整迁移在多工作区并行时可能超过 60 秒。
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => handle?.close());

describe('AC-SC-07 健康度读口的真实授权登记', () => {
  it('入口授权和事务内复核的探测事实均有查看权义务承接', () => {
    const { app } = tenantApi(handle.db);
    const route = routeManifest(app).declared.find(
      (entry) => entry.method === 'GET' && entry.path === '/api/tenant/succession/health-results',
    );
    const contract = readFrozenContract();
    expect(route).toBeDefined();
    expect(contract).toBeDefined();
    const findings = checkRequired(REQUIRED, contract!, [route!]);
    expect(findings, findings.map((finding) => `${finding.code}: ${finding.detail}`).join('\n')).toEqual([]);
  });
});
