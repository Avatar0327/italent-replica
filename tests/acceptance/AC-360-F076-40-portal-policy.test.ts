/**
 * AC-360-F076-40（PR-2a 部分：两条门户路由的 F-039 声明，设计 §5.1、§5.2）：
 * 登录 / 登出都是 public 声明，守卫齐全，台账策略为 none 并写理由（DEC-377③）。
 */
import { describe, expect, it } from 'vitest';
import { SURVEY360 } from './support/route-policy/required/survey360.js';
import { SURVEY360_PORTAL_POLICIES } from '../../apps/api/src/modules/survey360/policy.js';

describe('AC-360-F076-40 门户路由声明', () => {
  it('POST /login：public + survey360.credentialExchange，ledger none 带理由', () => {
    const hit = SURVEY360_PORTAL_POLICIES.lookup('POST /login');
    expect(hit?.module).toBe('survey360-portal');
    expect(hit?.policy.kind).toBe('public');
    expect(hit?.policy.guards).toContain('survey360.credentialExchange');
    expect(hit?.policy.kind === 'public' && hit.policy.dec).toContain('DEC-291 Q2');
    expect(hit?.policy.write?.ledger).toBe('none');
    expect(hit?.policy.write?.ledgerReason).toContain('DEC-377');
  });

  it('POST /logout：public + survey360.sessionPossession，ledger none 带理由', () => {
    const hit = SURVEY360_PORTAL_POLICIES.lookup('POST /logout');
    expect(hit?.policy.kind).toBe('public');
    expect(hit?.policy.guards).toContain('survey360.sessionPossession');
    expect(hit?.policy.write?.ledger).toBe('none');
    expect(hit?.policy.write?.ledgerReason).toContain('DEC-377');
  });

  it('AC-40 / DEC-426：翻页 required 指向本处理器，门户任务不借用个人链接入口证据', () => {
    const base = '/api/survey360/portal/tasks/:relationId/questionnaires/:questionnaireId';
    const page = SURVEY360[`POST ${base}/page-check`]!.flatMap((obligation) => obligation.at ?? []);
    expect(page.some((evidence) => evidence.unit.endsWith('#answerPageCheck'))).toBe(true);
    expect(page.some((evidence) => evidence.unit.endsWith('#answerSubmit'))).toBe(false);
    for (const [route, obligations] of Object.entries(SURVEY360)) {
      if (!route.includes(base)) continue;
      const units = obligations.flatMap((obligation) => obligation.at ?? []).map((evidence) => evidence.unit);
      expect(
        units.some((unit) => unit.endsWith('#registerPortalRoutes')),
        route,
      ).toBe(true);
      expect(
        units.some((unit) => unit.endsWith('#registerLinkRoutes')),
        route,
      ).toBe(false);
    }
  });

  it('AC-40：八条门户路由齐全，六条会话入口声明 answerSession', () => {
    const sessionRoutes = [
      'GET /',
      'GET /avatars/:attachmentId/content',
      'GET /tasks/:relationId/questionnaires/:questionnaireId',
      'PUT /tasks/:relationId/questionnaires/:questionnaireId',
      'POST /tasks/:relationId/questionnaires/:questionnaireId/submit',
      'POST /tasks/:relationId/questionnaires/:questionnaireId/page-check',
    ];
    expect([...SURVEY360_PORTAL_POLICIES.keys()].sort()).toEqual(
      [...sessionRoutes, 'POST /login', 'POST /logout'].sort(),
    );
    for (const route of sessionRoutes) {
      const policy = SURVEY360_PORTAL_POLICIES.lookup(route)?.policy;
      expect(policy?.kind).toBe('public');
      expect(policy?.guards).toContain('survey360.answerSession');
      if (!route.startsWith('GET')) expect(policy?.write?.ledger).toBe('single');
    }
  });
});
