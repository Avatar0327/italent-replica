/**
 * PR #74 第二轮 P2-4：调动表单的联动区块（是否变更合同及合同字段、调整薪资、试岗、交接人、职责转交），
 * 提交载荷带 linkage；联动详情展示失败明细并提供子项重试入口。真实 React SSR 渲染，不引入第二份运行时。
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { LinkageDraft, TransferFormModel } from '../../apps/web/src/transfer/types.js';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const web = (file: string) => new URL(`../../apps/web/src/transfer/${file}`, import.meta.url).pathname;

const linkage: LinkageDraft = {
  changeContract: true,
  contractTargetId: 'contract-1',
  contractFields: { endDate: '2029-10-09' },
  adjustSalary: true,
  onTrialMonths: 3,
  onTrialStartDate: '',
  handoverPersonId: 'employee-3',
  dutyReceiverId: 'employee-3',
  dutySubordinateIds: ['employee-2'],
  transferDepartmentHead: true,
};

function model(initiator: 'hr' | 'employee' = 'hr'): TransferFormModel {
  return {
    initiator,
    employees: [
      { id: 'employee-1', code: 'E001', name: '调动人', revision: 3 },
      { id: 'employee-2', code: 'E002', name: '下属', revision: 1 },
      { id: 'employee-3', code: 'E003', name: '接收人', revision: 1 },
    ],
    departments: [{ id: 'department-2', name: '调入部门' }],
    catalog: { types: [{ code: 'cross_department', name: '跨部门调动', formId: 'F' }], reasons: [] },
    employeeId: 'employee-1',
    effectiveDate: '2026-10-10',
    transferTypeCode: 'cross_department',
    reasonCode: '',
    fields: { departmentId: 'department-2' },
    customFields: {},
    linkage,
    contracts: [{ id: 'contract-1', name: 'CT-001 劳动合同' }],
    preview: {
      form: {
        id: 'F',
        name: '跨部门调动',
        isStandard: true,
        excludedAutofillFields: [],
        fieldModes: { 'preset:departmentId': 'editable' },
        customFields: [],
      },
      fields: { departmentId: 'department-2' },
      customFields: {},
      before: { fields: { departmentId: 'department-1' }, customFields: {} },
      employeeRevision: 3,
      allowDirectTransfer: true,
      allowedActions: { application: true, directList: true, directRow: true },
    },
  };
}

async function render(data: TransferFormModel) {
  const { TransferForm } = (await import(web('TransferForm.tsx'))) as { TransferForm: unknown };
  return renderToStaticMarkup(createElement(TransferForm, { model: data }));
}

describe('P2-4 调动表单联动区块', () => {
  it('HR 表单显示是否变更合同及合同字段、调整薪资、试岗、交接人与职责转交', async () => {
    const html = await render(model());
    for (const label of ['联动业务', '是否变更合同', '变更的合同', '合同终止日期', '是否调整薪资', '试岗期限（月）'])
      expect(html, label).toContain(label);
    for (const label of ['交接人', '职责转交', '下属转交给', '转交部门负责人']) expect(html, label).toContain(label);
    expect(html).toContain('CT-001 劳动合同');
  });

  it('本人调动申请没有联动区块（`12` 附录）', async () => {
    expect(await render(model('employee'))).not.toContain('联动业务');
  });

  it('提交载荷带 linkage：合同、调薪、试岗、交接、下属与部门负责人转交', async () => {
    const { transferBody } = (await import(web('api.ts'))) as {
      transferBody: (model: TransferFormModel, action: string) => Record<string, unknown>;
    };
    expect(transferBody(model(), 'submit')).toMatchObject({
      submit: true,
      linkage: {
        contract: { targetId: 'contract-1', fields: { endDate: '2029-10-09' } },
        adjustSalary: true,
        onTrial: { months: 3 },
        handover: { handoverPersonId: 'employee-3' },
        dutyTransfer: {
          subordinates: [{ employeeId: 'employee-2', receiverId: 'employee-3', relation: 'direct' }],
          orgRoles: [{ orgId: 'department-1', role: 'person_in_charge', receiverId: 'employee-3' }],
        },
      },
    });
    const none = transferBody({ ...model(), linkage: undefined }, 'draft');
    expect(none).not.toHaveProperty('linkage');
    const employee = transferBody(model('employee'), 'submit');
    expect(employee).not.toHaveProperty('linkage');
  });
});

describe('P2-4 联动详情：失败明细与重试入口', () => {
  it('列出失败数与失败原因，失败子项有重试按钮，成功子项没有', async () => {
    const { LinkagePanel } = (await import(web('LinkagePanel.tsx'))) as { LinkagePanel: unknown };
    const item = (id: string, status: string, failure: object | null) => ({
      id,
      revision: 2,
      itemType: 'duty_subordinate',
      subordinateId: id,
      orgId: null,
      orgRole: null,
      relation: 'direct',
      receiverId: 'employee-3',
      partTimeRecordId: null,
      effectiveDate: '2026-10-10',
      status,
      attemptCount: 1,
      lastAttemptAt: null,
      failure,
    });
    const html = renderToStaticMarkup(
      createElement(LinkagePanel, {
        view: {
          businessId: 'b-1',
          executedAt: '2026-10-10T01:00:00.000Z',
          options: {},
          contract: null,
          onTrial: null,
          handover: null,
          salaryReminder: { status: 'pending', createdAt: '2026-10-10T01:00:00.000Z' },
          dutyTransfer: {
            total: 2,
            subordinateCount: 2,
            orgRoleCount: 0,
            failedCount: 1,
            items: [
              item('ok', 'succeeded', null),
              item('bad', 'failed', { code: 'VALIDATION_FAILED', message: '汇报线循环', rule: null }),
            ],
          },
          partTimes: [],
        },
      }),
    );
    expect(html).toContain('失败 1');
    expect(html).toContain('汇报线循环');
    expect(html).toContain('待调薪');
    expect(html.match(/data-retry-item/g)).toHaveLength(1);
  });
});
