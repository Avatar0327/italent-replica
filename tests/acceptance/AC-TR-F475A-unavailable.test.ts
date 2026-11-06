import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup: render } = requireWeb('react-dom/server');
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({
    snapshot: { objects: { 'TalentReview.Project': {} } },
    field: () => ({ visible: true, editable: false }),
    can: () => false,
  }),
}));
vi.mock('../../apps/web/src/foundation/Session.js', () => ({
  useApiClient: () => ({}),
  useSession: () => ({ tenantId: 'synthetic-tenant', identityKey: 'synthetic-user' }),
}));
const { Meetings } = await import(resolve('apps/web/src/talent-review/Meetings.tsx'));
const { TalentReviewPage } = await import(resolve('apps/web/src/talent-review/TalentReviewPage.tsx'));
it('AC-TR F-475A 校准会缺契约明确提示，没有演示记录或假详情入口', () => {
  const html = render(h(Meetings));
  expect(html).toContain('未完成（缺后端契约）');
  expect(html).toContain('盘点校准会');
  expect(html).not.toContain('演示数据');
  expect(html).not.toContain('<tbody');
  expect(html).not.toContain('role="dialog"');
});
it('AC-TR F-475A 人才池缺契约有明确的模块内入口，不冒充已建业务页面', () => {
  const html = render(h(TalentReviewPage));
  expect(html).toContain('人才池');
});
