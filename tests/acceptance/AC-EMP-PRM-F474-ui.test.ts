/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, h, permission, uiHarness } from './support/f474-ui.js';
const { StaffPage } = await import(resolve('apps/web/src/personnel/StaffPage.tsx'));
const { SubsetCreate } = await import(resolve('apps/web/src/personnel/EditCommands.tsx'));
const { userColumns } = await import(resolve('apps/web/src/settings/user-columns.tsx'));
const { teamKeys } = await import(resolve('apps/web/src/self-service/pages/model.ts'));
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
describe('AC-EMP / AC-PRM F-474 员工、团队与用户列表', () => {
  it('员工已确认首屏姓名、编码140，参加工作日期105，操作164，齿轮24', async () => {
    await ui.render(h(StaffPage));
    const widths = ui.widths();
    expect(widths.slice(0, 4)).toEqual(['140px', '140px', '105px', '140px']);
    expect(widths.slice(-2)).toEqual(['164px', '24px']);
  });
  it('内部员工列表已有字段采用原站宽度，数据缺口不拼合成值', () => {
    const columns = userColumns(true, () => {});
    expect(columns.map((column: { width?: number }) => column.width)).toEqual([
      128, 128, 188, 128, 128, 128, 128, 93, 118, 128,
    ]);
  });
  it('全部用户列表已有字段按原站宽度', () => {
    expect(userColumns(false, () => {}).map((column: { width?: number }) => column.width)).toEqual([
      128, 128, 188, 128, 128, 128, 128, 118, 146, 128,
    ]);
  });
  it('团队成员人员先于状态；被裁剪字段不补回', () => {
    expect(
      teamKeys([{ name: '合成员工', employeeStatus: 2, departmentId: null, postId: null, email: 'a@example.com' }]),
    ).toEqual(['name', 'postId', 'departmentId', 'email', 'employeeStatus']);
    expect(teamKeys([{ departmentId: null }])).toEqual(['departmentId']);
  });
  it('人员子集新增为右侧叠加表单，保持内核', async () => {
    const fields = ['school', 'startDate', 'endDate'];
    await ui.render(
      h(SubsetCreate, {
        employeeId: '30000000-0000-4000-8000-000000000474',
        kind: 'education',
        permission: permission(fields),
        saved() {},
      }),
    );
    const button = ui.host.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(document.querySelector('.ant-drawer [role="dialog"]')).not.toBeNull();
    expect(document.querySelector('.ant-modal')).toBeNull();
  });
});
