/**
 * AC-PRM-F075（DEC-369）去掉的 41 项冗余授权调用确实不再发生：发现探测的冻结事实（逐字节与重新探测相等，见
 * AC-PRM-FW-08.discovery）里，这 19 个端点的授权轨迹不再含这些请求键；它们也不在两本未认领账里。
 * “返回完全一致”由 AC-PRM-F075-survey360 / -qualification / -idp 的对照转录证明。
 */
import { describe, expect, it } from 'vitest';
import { readFrozenProbes } from './support/route-policy/discovery.js';
import { KNOWN_GAPS } from './support/route-policy/probe-known-gaps.js';
import { REDUNDANT_OBSERVATIONS } from './support/route-policy/probe-redundant.js';

/** 原审定的 41 项（端点 → 不再被问的请求键）。 */
const DROPPED: readonly (readonly [string, readonly string[]])[] = [
  [
    'DELETE /api/tenant/survey360/questionnaires/:id',
    ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view'],
  ],
  ['GET /api/tenant/survey360/questionnaires', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  [
    'GET /api/tenant/survey360/questionnaires/:id',
    ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view'],
  ],
  ['POST /api/tenant/survey360/questionnaires', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  [
    'POST /api/tenant/survey360/questionnaires/:id/enable',
    ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view'],
  ],
  [
    'PUT /api/tenant/survey360/questionnaires/:id',
    ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view'],
  ],
  ['GET /api/tenant/survey360/roles', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  ['GET /api/tenant/survey360/settings', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  ['POST /api/tenant/survey360/roles', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  ['PUT /api/tenant/survey360/roles/:id', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  ['PUT /api/tenant/survey360/settings', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  ['POST /api/tenant/survey360/activities', ['btn:Survey360.Activity#viewAll@list', 'obj:Survey360.Activity:view']],
  ['PATCH /api/tenant/qualification/categories/:id', ['obj:Qualification.EmploymentCategoryClassify:view']],
  ['PATCH /api/tenant/qualification/category-classes/:id', ['obj:Qualification.EmploymentCategoryClassify:view']],
  [
    'PATCH /api/tenant/qualification/standards/:id',
    ['obj:Qualification.EmploymentCategory:view', 'obj:Qualification.EmploymentLevel:view'],
  ],
  ['PATCH /api/tenant/qualification/target-types/:id', ['obj:Qualification.TargetType:view']],
  ['PATCH /api/tenant/qualification/targets/:id', ['obj:Qualification.TargetType:view']],
  [
    'GET /api/tenant/idp/plans',
    [
      'obj:IDP.Analysis:view',
      'obj:IDP.Career:view',
      'obj:IDP.GoalReview:view',
      'obj:IDP.IDPTemplateModule:view',
      'obj:IDP.IdpGoal:view',
      'obj:IDP.Review:view',
      'obj:IDP.Task:view',
      'obj:IDP.TutorShip:view',
      'obj:IDP.WorkShift:view',
    ],
  ],
  ['GET /api/tenant/idp/templates', ['obj:IDP.IDPTemplateCommonGoal:view', 'obj:IDP.IDPTemplateModule:view']],
];

describe('AC-PRM-F075 去掉的 41 项冗余授权调用不再发生', () => {
  const probes = readFrozenProbes();

  it('19 个端点共 41 个请求键：授权轨迹里不再出现', () => {
    expect(DROPPED.flatMap(([, keys]) => keys)).toHaveLength(41);
    for (const [endpoint, keys] of DROPPED) {
      const found = probes[endpoint];
      expect(found, endpoint).toBeDefined();
      for (const key of keys) expect(found!.trace, `${endpoint} 不应再问 ${key}`).not.toContain(key);
    }
  });

  it('也不在已知缺口 / 冗余观测两本账里（账里只剩 #125 套卷模板入口 18 项，等用户答复）', () => {
    const accounted = new Set(
      [...KNOWN_GAPS, ...REDUNDANT_OBSERVATIONS].flatMap((g) => g.pairs.map(([e, k]) => `${e}\t${k}`)),
    );
    for (const [endpoint, keys] of DROPPED) {
      for (const key of keys) expect(accounted.has(`${endpoint}\t${key}`), `${endpoint} ${key}`).toBe(false);
    }
  });

  it('只去掉预取，不动其余授权：这些端点的轨迹仍含各自的准入请求（至少一个）', () => {
    for (const [endpoint] of DROPPED) {
      expect(probes[endpoint]!.trace.length, endpoint).toBeGreaterThan(0);
    }
  });
});
