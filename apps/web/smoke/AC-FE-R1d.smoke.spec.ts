import { test, expect, user, employee } from './fixtures.js';

const profileId = '40000000-0000-4000-8000-000000000001';
const recordId = '50000000-0000-4000-8000-000000000001';
const menus = [
  ['users.all', '用户管理/全部用户'],
  ['permission.profiles', '权限管理/身份管理'],
  ['permission.user_grant', '权限管理/用户授权'],
  ['permission.mous', '权限管理/管理单元'],
  ['audit.business', '日志审计/业务操作日志'],
] as const;

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
const enterpriseUser = {
  userId: user,
  email: 'demo@example.com',
  displayName: '合成员工',
  userType: 'internal',
  businessIdentity: null,
  employeeId: employee,
  membershipStatus: 'active',
  membershipRevision: 1,
  accountStatus: 'active',
  accountRevision: 1,
};
const profile = {
  id: profileId,
  code: 'demo_profile',
  name: '合成业务身份',
  description: '合成演示身份说明',
  source: 'custom',
  apps: ['TenantBase'],
  licenseType: null,
  revision: 1,
  autoHeld: false,
};
const mou = {
  id: recordId,
  code: 'demo_mou',
  name: '合成管理单元',
  description: '合成组织范围',
  kind: 'named',
  status: 'active',
  parentId: null,
  revision: 1,
  orgRanges: [],
};
const audit = {
  id: recordId,
  occurredAt: '2026-10-13T01:00:00.000Z',
  operator: { userId: user, name: '合成员工' },
  operation: 'update',
  operationLabel: '修改',
  app: '企业设置',
  objectType: 'permission_profile',
  objectLabel: '身份',
  objectId: profileId,
  action: 'permission_profile.update',
  content: '合成审计变更',
  changes: [],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/tenant/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/tenant/permission/admin-menus': {
        items: menus.map(([code, path]) => ({ code, path, implemented: true, editable: code !== 'audit.business' })),
      },
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
      '/api/tenant/permission/users': { items: [enterpriseUser] },
      [`/api/tenant/permission/users/${user}`]: enterpriseUser,
      '/api/tenant/permission/profiles': { items: [profile] },
      [`/api/tenant/permission/profiles/${profileId}`]: { ...profile, objects: [] },
      '/api/tenant/permission/grantable-profiles': { items: [profile] },
      '/api/tenant/permission/grants': {
        items: [{ id: recordId, userId: user, profileId, source: 'manual', status: 'active', revision: 1 }],
      },
      '/api/tenant/permission/mous': { items: [mou] },
      [`/api/tenant/permission/mous/${recordId}`]: mou,
      '/api/tenant/audit/data-changes': { items: [audit], nextCursor: null },
      [`/api/tenant/audit/data-changes/${recordId}`]: {
        ...audit,
        before: { name: '合成旧名称' },
        after: { name: '合成新名称' },
        snapshot: null,
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
  { name: '全部用户', path: '/settings/menu/users.all', content: 'demo@example.com' },
  { name: '身份管理', path: '/settings/menu/permission.profiles', content: '合成业务身份' },
  { name: '用户授权', path: '/settings/menu/permission.user_grant', content: '合成业务身份' },
  { name: '管理单元', path: '/settings/menu/permission.mous', content: '合成管理单元' },
  { name: '数据变更日志', path: '/settings/menu/audit.business', content: '合成审计变更' },
] as const;

for (const item of pages) {
  test(`AC-FE-R1d 页面冒烟：切换演示身份后打开${item.name}`, async ({ page }) => {
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
