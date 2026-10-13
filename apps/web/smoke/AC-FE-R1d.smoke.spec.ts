import { test, expect, user, employee } from './fixtures.js';

const recordId = '50000000-0000-4000-8000-000000000001';

// 只使用合成数据；接口结构来自现有后端。页面路径沿用 FE-0 的应用及企业设置菜单入口。
const record = {
  id: recordId,
  kind: 'hire',
  effectiveDate: '2026-10-01',
  stopDate: null,
  approvalStatus: 'effective',
  fields: { departmentId: '60000000-0000-4000-8000-000000000001' },
  fieldLabels: { departmentId: '合成研发部' },
};
const ownProfile = {
  employee: { id: employee, name: '合成员工', code: 'DEMO-001', revision: 1 },
  timezone: 'Asia/Shanghai',
  today: '2026-10-13',
  record,
};
test.beforeEach(async ({ page }) => {
  await page.route('**/api/tenant/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/tenant/self-service/profile': ownProfile,
      [`/api/tenant/self-service/employees/${employee}/records`]: { items: [record] },
      '/api/tenant/self-service/applications': {
        items: [
          {
            id: recordId,
            businessId: recordId,
            revision: 1,
            title: '合成本人调动申请',
            category: '人事变动',
            initiator: '合成员工',
            status: 'in_review',
            currentHandlers: ['合成审批人'],
            reason: '合成申请理由',
            createdAt: '2026-10-13T01:00:00.000Z',
          },
        ],
      },
      [`/api/tenant/self-service/applications/${recordId}`]: { status: 'in_review', record },
      '/api/tenant/employment/transfers/manager/team': {
        items: [{ id: employee, name: '合成团队成员', code: 'DEMO-002', display: { departmentId: '合成研发部' } }],
        counts: { active: 1, probation: 0, intern: 0, pending: 0, leaving: 0 },
      },
      '/api/tenant/employment/transfers/manager/todos': {
        items: [{ id: recordId, taskId: recordId, title: '合成经理待办', status: 'running', nodeName: '经理审批' }],
      },
    };
    return Object.hasOwn(responses, path) ? route.fulfill({ json: responses[path] }) : route.fallback();
  });
});

const pages = [
  { name: '我的档案', path: '/self', content: '合成员工' },
  { name: '人事申请', path: '/self/applications', content: '合成研发部' },
  { name: '团队成员', path: '/manager/team', content: '合成团队成员' },
  { name: '待办', path: '/manager/todos', content: '合成经理待办' },
] as const;

for (const item of pages) {
  test(`AC-FE-R1d-1 页面冒烟：切换演示身份后打开${item.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(item.path);
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(item.path);
    await expect(page.locator('.shell-workspace')).toContainText(item.content);
    await expect(page.locator('.shell-workspace')).not.toContainText('正在加载');
    await expect(page.locator('.ant-breadcrumb')).toHaveCount(0);
    if (item.path !== '/self') await expect(page.locator('.shell-workspace .ant-table')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
