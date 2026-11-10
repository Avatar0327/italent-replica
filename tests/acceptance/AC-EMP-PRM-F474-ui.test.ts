/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, allFields, h, permission, uiHarness } from './support/f474-ui.js';
const { SelfPage } = await import(resolve('apps/web/src/self-service/pages/SelfPage.tsx'));
const { StaffPage } = await import(resolve('apps/web/src/personnel/StaffPage.tsx'));
const { SubsetCreate } = await import(resolve('apps/web/src/personnel/EditCommands.tsx'));
const { userColumns } = await import(resolve('apps/web/src/settings/user-columns.tsx'));
const { subsetFields } = await import(resolve('apps/web/src/personnel/edit-model.ts'));
const { ProfilesPage } = await import(resolve('apps/web/src/settings/ProfilesPage.tsx'));
const { AuditPage } = await import(resolve('apps/web/src/settings/AuditPage.tsx'));
const { teamKeys } = await import(resolve('apps/web/src/self-service/pages/model.ts'));
let ui: ReturnType<typeof uiHarness>;
const allFieldsWithout = (...hidden: string[]) => allFields.filter((field) => !hidden.includes(field));
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
describe('AC-EMP / AC-PRM F-474 员工、团队与用户列表', () => {
  it('员工列表首屏列序与宽度：姓名、员工ID、机构ID、组织全称、雇佣关系、职位、首次参加工作日期、性别', async () => {
    await ui.render(h(StaffPage));
    // 原站首屏 140 / 140 / 140 / 140 / 140 / 140 / 105 / 140，操作 164、齿轮 24（F-474-4a 补齐机构ID等四列）
    expect(ui.widths().slice(0, 8)).toEqual(['140px', '140px', '140px', '140px', '140px', '140px', '105px', '140px']);
    expect(ui.widths().slice(-2)).toEqual(['164px', '24px']);
    expect(ui.headers().slice(0, 8)).toEqual([
      '员工姓名',
      '员工ID',
      '机构ID',
      '组织全称',
      '雇佣关系',
      '职位',
      '首次参加工作日期',
      '性别',
    ]);
    expect(ui.widths()[8]).toBe('155px'); // 未取证的横滚列保持原宽度，不能一律设为140。
  });
  it('员工列表补列取值：雇佣关系显示中文，空值显示占位；无查看权的列不显示', async () => {
    const row = { id: '30000000-0000-4000-8000-000000000474', name: '合成员工', code: 'SYNTH-474' };
    const items = [
      { ...row, orgCode: 'O474', orgFullName: '合成集团/合成部', employType: 'intern', positionName: '合成职位' },
      { ...row, id: '30000000-0000-4000-8000-000000000475', code: 'SYNTH-475' },
    ];
    await ui.render(h(StaffPage), '/', undefined, { '/api/tenant/personnel/employees': { items, total: 2 } });
    const cells = Array.from(ui.host.querySelectorAll('tbody tr:not([aria-hidden]) td')).map((c) => c.textContent);
    expect(cells.slice(2, 6)).toEqual(['O474', '合成集团/合成部', '实习生', '合成职位']);
    expect(cells.slice(16, 20)).toEqual(['—', '—', '—', '—']); // 每行 14 格：12 列 + 操作 + 齿轮
    await ui.close();
    ui = uiHarness();
    await ui.render(h(StaffPage), '/', allFieldsWithout('orgFullName', 'positionName'));
    expect(ui.headers().slice(0, 5)).toEqual(['员工姓名', '员工ID', '机构ID', '雇佣关系', '首次参加工作日期']);
  });
  it('内部员工列表已有字段采用原站宽度，数据缺口不拼合成值', () => {
    const columns = userColumns(true, () => {});
    expect(columns.map((column: { width?: number }) => column.width)).toEqual([
      128, 128, 188, 128, 128, 128, 128, 93, 118, 128,
    ]);
  });
  it('全部用户列表补齐员工状态与齿轮，保持原站列宽', () => {
    expect(userColumns(false, () => {}).map((column: { width?: number }) => column.width)).toEqual([
      128, 128, 188, 128, 128, 128, 128, 118, 146, 128, 128, 24,
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

describe('AC-EMP / AC-PRM F-474 子集顺序与设置列表', () => {
  it.each([
    ['education', ['school', 'graduationType', 'startDate', 'endDate', 'educationLevel']],
    ['jobhistory', ['company', 'post', 'startDate', 'endDate', 'referenceName']],
    [
      'training',
      [
        'name',
        'institution',
        'category',
        'score',
        'categoryName',
        'startDate',
        'endDate',
        'hours',
        'classification',
        'passed',
      ],
    ],
    ['family', ['name', 'birthday', 'gender', 'relationship', 'mobilePhone']],
    [
      'language-ability',
      ['language', 'isNative', 'proficiency', 'writing', 'reading', 'speaking', 'acquiredCertificate'],
    ],
    ['awards', ['name', 'awardDate', 'amount', 'payDate', 'description']],
    ['skill', ['name', 'proficiency', 'category', 'months']],
    ['professional-technical-post', ['qualificationName', 'level', 'assessmentDate', 'qualificationRoute']],
  ])('%s 的已有字段按取证顺序排列', (kind, fields) => {
    expect(
      subsetFields(kind)
        .map((field: { code: string }) => field.code)
        .slice(0, fields.length),
    ).toEqual(fields);
  });
  it('身份管理补齐修改人时间等列，保持原站列宽', async () => {
    await ui.render(h(ProfilesPage, { title: '身份管理', editable: false }));
    expect(ui.widths()).toEqual([193, 128, 128, 128, 128, 128, 128, 118, 146, 128, 168, 24].map((n) => `${n}px`));
  });
  it('变更日志补齐应用和来源列，保持已有列宽', async () => {
    await ui.render(h(AuditPage));
    expect(ui.widths()).toEqual([128, 118, 146, ...Array(11).fill(128), 24].map((n) => `${n}px`));
  });
});

describe('AC-EMP F-474 自助任职记录', () => {
  it('只将已返回字段排成姓名、部门、职位、日期、审批状态，不补不可见字段', async () => {
    const employee = { id: '30000000-0000-4000-8000-000000000474', name: '合成用户', code: 'SYNTH-474' };
    const record = {
      id: '40000000-0000-4000-8000-000000000474',
      effectiveDate: '2026-11-03',
      stopDate: null,
      approvalStatus: 'effective',
      fields: { positionId: null, departmentId: null },
      fieldLabels: {},
    };
    await ui.render(h(SelfPage), '/self/applications', undefined, {
      '/api/tenant/self-service/profile': {
        employee,
        record,
        timezone: 'Asia/Shanghai',
        today: '2026-11-03',
        selfServiceButtons: [],
      },
      [`/api/tenant/self-service/employees/${employee.id}/records`]: { items: [record], total: 1 },
    });
    expect(ui.headers()).toEqual(['姓名', '部门', '职位', '开始日期', '结束日期', '审批状态']);
    expect(ui.widths()).toEqual([140, 140, 140, 105, 105, 140].map((n) => `${n}px`));
  });
});
