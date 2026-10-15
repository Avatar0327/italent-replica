import { test, expect, employee, user } from './fixtures.js';
import { mockIdp, orgId, otherEmployee } from './r3d2-fixtures.js';

// F-154 首批行为红测。夹具仅含现有 key-info-routes 的真实投影字段，
// 不伪造尚未落库的职业发展条线 / 拟晋升职级 / 拟晋升职务。
// TODO(需取证 #355)：候选来源与当前任职取值口径确认后，再补齐写入和恢复用例。
const span = { startDate: '2026-10-01', endDate: '2026-12-31', revision: 1, createdBy: user };
const cases = [
  {
    path: 'tutorships',
    title: '带教信息',
    create: '新增',
    count: 5,
    fields: ['带教人', '被带教人', '开始时间', '结束日期'],
    row: { ...span, tutorEmployeeId: otherEmployee, tuteeEmployeeId: employee, remark: null },
    headers: ['带教人', '带教人邮箱', '带教人部门', '被带教人', '被带教人邮件', '被带教人部门', '开始时间', '结束日期'],
  },
  {
    path: 'careers',
    title: '职业发展信息',
    create: '新建',
    count: 4,
    fields: [
      '发展员工',
      '开始时间',
      '结束时间',
      '优势项',
      '待发展项',
      '发展条线',
      '拟晋升职级',
      '拟晋升职位',
      '拟晋升职务',
    ],
    row: {
      ...span,
      employeeId: employee,
      targetPositionId: null,
      strengths: null,
      developmentItems: null,
      intendedCity: null,
    },
    headers: [
      '发展员工',
      '开始时间',
      '结束时间',
      '优势项',
      '待发展项',
      '当前职级',
      '拟晋升职级',
      '当前职位',
      '拟晋升职位',
      '当前职务',
      '发展条线',
    ],
  },
  {
    path: 'work-shifts',
    title: '轮岗信息',
    create: '新建',
    count: 7,
    fields: ['姓名', '开始时间', '结束时间', '轮岗部门', '轮岗职位', '轮岗导师'],
    row: { ...span, employeeId: employee, orgId, positionId: null, postId: null, mentorEmployeeId: null },
    headers: ['姓名', '邮箱', '部门', '开始时间', '结束时间', '轮岗部门', '轮岗职位', '轮岗导师'],
  },
];

test.use({ viewport: { width: 1440, height: 900 } });
for (const [index, spec] of cases.entries()) {
  test(`AC-FE-F154-0${index + 1} ${spec.title}展示真实列表及新建字段`, async ({ page }) => {
    await mockIdp(page);
    await page.route(`**/api/tenant/idp/${spec.path}?*`, (route) =>
      route.fulfill({
        json: {
          page: 1,
          pageSize: 200,
          hasDataPermission: true,
          items: Array.from({ length: spec.count }, (_, i) => ({
            ...spec.row,
            id: `c1540000-0000-4000-8000-00000000000${i + 1}`,
          })),
        },
      }),
    );
    await page.goto('/');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.goto(`/idp/${spec.path}`);
    await expect(page.getByRole('heading', { name: spec.title, exact: true })).toBeVisible();
    for (const name of spec.headers) await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
    await expect(page.getByText(`共${spec.count}条`, { exact: true })).toBeVisible();
    for (const name of ['导入', '导出', '轮岗申请', '高级筛选'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: new RegExp(`^${spec.create.split('').join('\\s*')}$`) }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const field of spec.fields) await expect(dialog.getByText(field, { exact: true })).toBeVisible();
  });
}
