// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h, act, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import type * as TransferFixture from '../demo-stubs/transfer.js';
import { TransferList } from '../transfer/TransferList.js';
import { useCompleteGroups } from '../entries/CompleteFields.js';
import { useDesignerPeople } from '../approval/designer/FallbackHandlers.js';
import { UsersPage } from '../settings/UsersPage.js';
import { teamValue } from '../self-service/pages/model.js';
import { codeText } from './code-text.js';

vi.mock('../demo-stubs/transfer.js', async (original) => {
  const module = await original<typeof TransferFixture>();
  return { ...module, transferExamples: () => module.transferExamples().map((row) => ({ ...row, code: null })) };
});
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => {
  await ui.close();
});

it('FE-09 共享 codeText 空值、空串、非空与特殊字符', () => {
  expect(codeText(null)).toBe('--');
  expect(codeText('')).toBe('--');
  expect(codeText('001<&>')).toBe('001<&>');
});
it('FE-09 调动列表和详情人员卡片空工号 --', async () => {
  await ui.render(h(TransferList, { view: 'progress' }));
  const column = ui.headers().indexOf('工号');
  expect(column).toBeGreaterThan(-1);
  const rows = [...ui.host.querySelectorAll('tbody .ant-table-row')];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.querySelectorAll('td')[column]?.textContent).toBe('--');
  await act(() => rows[0]!.querySelector<HTMLButtonElement>('button')!.click());
  const detail = document.querySelector('.ant-drawer');
  expect(detail?.textContent).toContain('--');
  expect(detail?.textContent).not.toContain('null');
});
it('FE-09 入职完成信息工号 --', async () => {
  function Probe() {
    const { groups } = useCompleteGroups({ code: null }, false, false, () => {}, null);
    const field = groups.flatMap((group) => group.fields).find((field) => field.label === '工号');
    return h('output', { 'aria-label': '工号' }, field?.display);
  }
  await ui.render(h(Probe));
  expect(ui.host.querySelector('output')?.textContent).toBe('--');
});
it('FE-09 审批指定人员候选与回显包含空工号 --', async () => {
  function Probe() {
    const { known } = useDesignerPeople(['synthetic-person']);
    return h('output', {}, known?.choices.map((choice) => choice.label).join(','));
  }
  await ui.render(h(Probe), '/', undefined, {
    '/api/tenant/approval/designer/person-candidates': {
      items: [{ userId: 'synthetic-person', name: '合成审批人', code: null, departmentName: '合成部门' }],
      hasMore: false,
    },
  });
  expect(ui.host.querySelector('output')?.textContent).toBe('合成审批人 · -- · 合成部门');
});

it('FE-09 人员卡片和团队列表空工号走统一展示', () => {
  expect(teamValue({ id: 'synthetic', code: null }, 'code')).toBe('--');
});
it('FE-10 全部用户页面真实列入口，空登录名及联系邮箱分别展示', async () => {
  await ui.render(h(UsersPage, { code: 'users.all', title: '全部用户', editable: false }), '/', undefined, {
    '/api/tenant/permission/users': {
      items: [
        {
          userId: 'synthetic',
          displayName: '合成空登录名',
          email: '',
          contactEmail: 'contact@example.com',
          userType: 'internal',
          membershipStatus: 'active',
          membershipRevision: 1,
          employeeId: 'synthetic-person',
        },
      ],
      total: 1,
    },
  });
  const headers = ui.headers();
  const login = headers.indexOf('登录用户名');
  const contact = headers.indexOf('联系邮箱');
  expect(login).toBeGreaterThan(-1);
  expect(contact).toBe(login + 1);
  const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
  expect(cells[login]?.textContent).toBe('--');
  expect(cells[contact]?.textContent).toBe('contact@example.com');
});
