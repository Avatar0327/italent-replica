/** HR 真实表单：按服务端配置展示字段；租户关闭直接调动后，两个入口一并消失（DEC-051）。 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// React 已是 web 工作区依赖；验收使用其真实 SSR 渲染，不给根工作区引入第二份运行时。
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as {
  createElement: (component: unknown, props: unknown) => unknown;
};
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const componentPath = new URL('../../apps/web/src/transfer/TransferForm.tsx', import.meta.url).pathname;

function model(allowDirectTransfer = true) {
  return {
    employees: [{ id: 'employee-1', code: 'E001', name: '合成员工', revision: 3 }],
    departments: [{ id: 'department-2', name: '目标部门' }],
    catalog: {
      types: [{ code: 'job_level', name: '职级调整', formId: 'TenantBase.JobLevelTransferMultiFormView' }],
      reasons: [{ code: 'promotion', name: '升职', transferTypeCode: null }],
    },
    employeeId: 'employee-1',
    effectiveDate: '2026-10-06',
    transferTypeCode: 'job_level',
    reasonCode: '',
    fields: {},
    customFields: {},
    preview: {
      form: {
        id: 'TenantBase.JobLevelTransferMultiFormView',
        name: '职级调整多表单',
        isStandard: true,
        fieldModes: {
          'preset:departmentId': 'editable',
          'preset:levelId': 'editable',
          'preset:gradeId': 'editable',
          'preset:jobNumber': 'readonly',
          'custom:readonly-note': 'readonly',
          'custom:hidden-note': 'hidden',
          'custom:absent-note': 'absent',
          'custom:editable-note': 'editable',
        },
        customFields: [
          { id: 'readonly-note', name: '只读自定义项', valueType: 'text' },
          { id: 'hidden-note', name: '隐藏自定义项', valueType: 'text' },
          { id: 'absent-note', name: '未配置自定义项', valueType: 'text' },
          { id: 'editable-note', name: '可编辑自定义项', valueType: 'text' },
        ],
      },
      fields: { departmentId: 'department-2', levelId: null, gradeId: null, jobNumber: 'E001' },
      customFields: { 'readonly-note': '继承的只读值', 'editable-note': null },
      before: { fields: { departmentId: 'department-1', levelId: 'L1', gradeId: 'G1' }, customFields: {} },
      employeeRevision: 3,
      allowDirectTransfer,
    },
  };
}

async function render(allowDirectTransfer = true) {
  const { TransferForm } = (await import(componentPath)) as { TransferForm: unknown };
  return renderToStaticMarkup(createElement(TransferForm, { model: model(allowDirectTransfer) }));
}

describe('AC-TRF-03 / AC-TRF-18：HR 实际调动表单', () => {
  it('可选择授权员工、类型、原因、日期，成对展示原/新字段并保留职级职等不带出', async () => {
    const html = await render();
    expect(html).toContain('合成员工');
    expect(html).toContain('name="employeeId"');
    expect(html).toContain('name="effectiveDate"');
    expect(html).toContain('name="transferTypeCode"');
    expect(html).toContain('name="reasonCode"');
    expect(html).toContain('原职级');
    expect(html).toContain('L1');
    expect(html).toMatch(/name="levelId"[^>]*value=""/);
    expect(html).toMatch(/name="gradeId"[^>]*value=""/);
    expect(html).toContain('暂存');
    expect(html).toContain('提交');
  });

  it('只读字段显示继承值但不能编辑，隐藏/未配置字段不进入 DOM', async () => {
    const html = await render();
    expect(html).toMatch(/name="jobNumber"[^>]*readOnly=""/);
    expect(html).toMatch(/name="readonly-note"[^>]*readOnly=""/);
    expect(html).toContain('继承的只读值');
    expect(html).not.toContain('hidden-note');
    expect(html).not.toContain('absent-note');
    expect(html).toMatch(/name="editable-note"[^>]*value=""/);
  });
});

describe('AC-TRF-30：真实页面入口按租户开关隐藏', () => {
  it('默认开时提供两个直接调动入口', async () => {
    const html = await render();
    expect(html).toContain('data-button-code="EmploymentRecord.LineOp.Transfer"');
    expect(html).toContain('data-button-code="Employment.Tranfer"');
  });

  it('关闭后两处直接调动均消失，申请提交与暂存仍可用', async () => {
    const html = await render(false);
    expect(html).not.toContain('EmploymentRecord.LineOp.Transfer');
    expect(html).not.toContain('Employment.Tranfer');
    expect(html).toContain('提交');
    expect(html).toContain('暂存');
  });
});
