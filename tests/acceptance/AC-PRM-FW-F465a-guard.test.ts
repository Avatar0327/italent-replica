/**
 * AC-PRM-FW F-465a 第 2 轮 P2-2：人事报表“按编码强制准入”（1.06 合同 / 1.07、1.1.01、1.1.02 任职记录对象查看权，
 * 缺失 403）必须由 F-039 守得住，不能只登记成花名册式的可选披露。
 * - 准入分派抽成具名守卫 hrAnalysis.reportObjects（report-routes.ts requireReportObjects），声明挂在 :code 与
 *   :code/export 两条路由上，必需项表登记该守卫的调用、拒绝语义与两个“条件准入”对象（when:hrAnalysis.reportObjects）；
 * - 反例：声明里删掉守卫 → REQUIRED_MISSING；源码里删掉守卫调用 / 把拒绝改成只裁列 → EVIDENCE_STALE。
 * 不改核心门禁（evidence-core.ts / core-digests.ts）。
 */
import { type ManifestRoute, routeManifest, type RouteManifest } from '@italent/api';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { Finding } from './support/route-policy/compare.js';
import { checkEvidence, repoSource, type SourceReader } from './support/route-policy/evidence.js';
import { checkRequired } from './support/route-policy/required.js';
import { requiredMutants } from './support/route-policy/required-mutate.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import { tenantApi } from './support/tenant-api.js';

let handle: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => handle?.close());

const GUARD = 'hrAnalysis.reportObjects';
const ROUTES = [
  'GET /api/tenant/hr-analysis/reports/:code',
  'GET /api/tenant/hr-analysis/reports/:code/export',
] as const;
const REPORT_ROUTES = 'apps/api/src/modules/hr-analysis/report-routes.ts';
const OBJECTS = ['TenantBase.EmploymentRecord', 'TenantBase.EmploymentContract'];

let manifest: RouteManifest;
beforeAll(() => {
  manifest = routeManifest(tenantApi(handle.db, { authorize: undefined }).app);
});

const route = (key: string): ManifestRoute => {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
};
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.code}: ${f.detail}`).join('\n');
const frozen = () => readFrozenContract()!;
const only = (key: string) => ({ [key]: REQUIRED[key] ?? [] });
/** 只改 report-routes.ts 的源码，其余文件照读。 */
const patched =
  (change: (text: string) => string): SourceReader =>
  (file) =>
    file === REPORT_ROUTES ? change(repoSource(file)) : repoSource(file);

describe('AC-PRM-FW F-465a P2-2：报表对象准入是具名守卫 + 条件准入，不是可选披露', () => {
  for (const key of ROUTES) {
    it(`${key}：表里登记守卫（调用 + 拒绝实现）与两个 when 条件准入对象`, () => {
      const table = REQUIRED[key] ?? [];
      const guard = table.find((o) => o.perm === `guard:${GUARD}` && !o.purpose);
      expect(guard, '守卫必须是准入义务').toBeDefined();
      const roles = guard!.at.map((e) => `${e.role}:${e.unit.split('#')[0]}`);
      expect(roles).toContain(`call:${REPORT_ROUTES}`);
      expect(roles).toContain(`impl:${REPORT_ROUTES}`);
      for (const object of OBJECTS) {
        const when = table.find((o) => o.perm === `obj:${object}:view` && o.purpose === `when:${GUARD}`);
        expect(when, `${object} 必须登记 when:${GUARD}`).toBeDefined();
      }
    });

    it(`${key}：真实声明 × 真实表零发现，且声明挂了守卫`, () => {
      expect(JSON.stringify(route(key).policy)).toContain(`"${GUARD}"`);
      const findings = checkRequired(REQUIRED, frozen(), [route(key)]);
      expect(codes(findings), show(findings)).toEqual([]);
    });

    it(`${key}：声明里删掉守卫 → REQUIRED_MISSING（条件准入突变）`, () => {
      const mutants = requiredMutants(route(key), REQUIRED).filter((m) => m.kind === 'conditional→none');
      expect(mutants.length, '没有任何条件准入能施加突变').toBeGreaterThan(0);
      for (const mutant of mutants) {
        const findings = checkRequired(REQUIRED, frozen(), [mutant.route]);
        expect(codes(findings), `${mutant.perm}\n${show(findings)}`).toContain('REQUIRED_MISSING');
      }
    });

    it(`${key}：源码删掉守卫调用 → EVIDENCE_STALE；把拒绝改成不拒绝（只裁列）→ EVIDENCE_STALE`, () => {
      const removed = patched((text) => text.replaceAll('requireReportObjects(rights, report);', ''));
      expect(codes(checkEvidence(only(key), { read: removed })), '删守卫调用').toContain('EVIDENCE_STALE');
      const softened = patched((text) =>
        text.replace(/(function requireReportObjects[\s\S]*?)throw new AppError/, '$1void new AppError'),
      );
      expect(codes(checkEvidence(only(key), { read: softened })), '拒绝改成不拒绝').toContain('EVIDENCE_STALE');
    });
  }

  it('基线：未改源码时两条路由的证据零发现', () => {
    for (const key of ROUTES) expect(checkEvidence(only(key)), key).toEqual([]);
  });
});
