// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h, act, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import type * as TransferFixture from '../demo-stubs/transfer.js';
import { TransferList } from '../transfer/TransferList.js';
import { useCompleteGroups } from '../entries/CompleteFields.js';
import { useDesignerPeople } from '../approval/designer/FallbackHandlers.js';
import { UsersPage } from '../settings/UsersPage.js';
import { teamValue } from '../self-service/pages/model.js';
import { AllPeoplePage } from '../all-people/AllPeoplePage.js';
import { ReportTable } from '../hr-reports/ReportTable.js';
import { RecordDetails } from '../employee-self-service/EmployeePage.js';
import { ApprovalFields } from '../approval/ApprovalDetail.js';
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
  expect(teamValue({ id: 'synthetic', display: { code: '不可见值' } }, 'code')).toBe('--');
  expect(teamValue({ id: 'synthetic' }, 'email')).toBe('—');
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

it.each([null, '0'])('FE-09 全部人员实际列表工号 %s，非工号空值不变', async (code) => {
  await ui.render(h(AllPeoplePage), '/all-people', undefined, {
    '/api/tenant/employment/all-people': {
      columns: [
        { key: 'code', label: '工号' },
        { key: 'email', label: '邮箱' },
      ],
      items: [{ employeeId: 'synthetic', code, email: null }],
      total: 1,
    },
  });
  const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
  expect(cells[ui.headers().indexOf('工号')]?.textContent).toBe(code ?? '--');
  expect(cells[ui.headers().indexOf('邮箱')]?.textContent).toBe('—');
});
it.each([null, '0'])('FE-09 人事报表实际表格工号 %s，其他空值不变', async (code) => {
  await ui.render(
    h(ReportTable, {
      code: 'roster',
      page: 1,
      changePage: () => {},
      data: {
        columns: [
          { key: 'code', label: '工号' },
          { key: 'email', label: '邮箱' },
        ],
        items: [{ code, email: null }],
        total: 1,
        page: 1,
        pageSize: 20,
        hasDataPermission: true,
      },
    }),
  );
  const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
  expect(cells[0]?.textContent).toBe(code ?? '--');
  expect(cells[1]?.textContent).toBe('—');
});
it('FE-09 内部员工未提供工号时走统一占位，部门占位不变', async () => {
  await ui.render(h(UsersPage, { code: 'users.internal', title: '内部员工', editable: false }), '/', undefined, {
    '/api/tenant/permission/users': { items: [{ userId: 'synthetic', displayName: '合成人员', email: '' }], total: 1 },
  });
  const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
  expect(cells[ui.headers().indexOf('工号')]?.textContent).toBe('--');
  expect(cells[ui.headers().indexOf('部门')]?.textContent).toBe('—');
});
it.each([null, '0'])('FE-09 本人任职详情工号 %s', async (jobNumber) => {
  await ui.render(h(RecordDetails, { record: { id: 'synthetic', fields: { jobNumber }, fieldLabels: {} } }));
  expect(ui.host.querySelector('.employee-details div dd')?.textContent).toBe(jobNumber ?? '--');
});
it('FE-09 审批只读工号与原值都走统一展示，其他空字段保留原占位', async () => {
  await ui.render(
    h(ApprovalFields, {
      detail: {
        id: 'synthetic',
        title: '合成审批',
        approvalType: 'transfer',
        revision: 1,
        actions: [],
        recordsHidden: true,
        tasks: [],
        logs: [],
        form: { values: { jobNumber: null, code: '0', place: null }, originals: { jobNumber: '0', code: null } },
      },
    }),
  );
  const values = [...ui.host.querySelectorAll('.approval-field dd')].map((node) => node.textContent);
  expect(values).toEqual(['--原：0', '0原：--', '—']);
});
