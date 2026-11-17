/** F-481 S3b §10：本片声明/静态义务/源码锚点硬比对，不把手写登记问题当生成物漂移。 */
import { routeManifest } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ESIGN } from './support/route-policy/required/esign.js';
import { checkRequired } from './support/route-policy/required.js';
import { checkEvidence } from './support/route-policy/evidence.js';
import { tenantApi } from './support/tenant-api.js';

const db = useTestDb();
const keys = [
  'GET /api/tenant/esign/records',
  'POST /api/tenant/esign/records/remind',
  'POST /api/tenant/esign/records/revoke',
  'GET /api/tenant/esign/records/files',
  'GET /api/tenant/esign/mine/:id/files',
];
const table = Object.fromEntries(keys.map((key) => [key, ESIGN[key]!]));
describe('AC-TRF-F481-15 / 16 / 22 F-039 登记', () => {
  it('五个入口的准入义务与运行时声明一致', () => {
    const manifest = routeManifest(tenantApi(db().db).app);
    const routes = manifest.declared.filter((r) => keys.includes(`${r.method} ${r.path}`));
    expect(routes).toHaveLength(5);
    expect(checkRequired(table, { routes: {}, domains: {} }, routes)).toEqual([]);
  });
  it('对象/按钮/files 守卫/范围/本人谓词的证据锚点全部命中', () => {
    expect(checkEvidence(table, { branch: false })).toEqual([]);
  });
});
