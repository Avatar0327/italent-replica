/** HR 真实表单：按服务端配置展示字段；租户关闭直接调动后，两个入口一并消失（DEC-051）。 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { FieldMode, TransferFormModel } from '../../apps/web/src/transfer/types.js';

// React 已是 web 工作区依赖；验收使用其真实 SSR 渲染，不给根工作区引入第二份运行时。
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as {
  createElement: (component: unknown, props: unknown) => unknown;
};
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const componentPath = new URL('../../apps/web/src/transfer/TransferForm.tsx', import.meta.url).pathname;

function model(allowDirectTransfer = true): TransferFormModel {
  return {
    employees: [{ id: 'employee-1', code: 'E001', name: '合成员工', revision: 3 }],
    departments: [{ id: 'department-2', name: '目标部门' }],
    references: { levelId: [{ id: 'L1', name: 'L1' }], gradeId: [{ id: 'G1', name: 'G1' }] },
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
        excludedAutofillFields: ['levelId', 'gradeId'],
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
      allowedActions: { application: true, directList: true, directRow: true },
    },
  };
}

async function render(allowDirectTransfer = true, directPermission = true) {
  const { TransferForm } = (await import(componentPath)) as { TransferForm: unknown };
  const data = model(allowDirectTransfer);
  return renderToStaticMarkup(
    createElement(TransferForm, {
      model: {
        ...data,
        preview: {
          ...data.preview,
          allowedActions: { application: true, directList: directPermission, directRow: directPermission },
        },
      },
    }),
  );
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
    expect(html).toMatch(/<select name="levelId"[^>]*><option value="" selected=""/);
    expect(html).toMatch(/<select name="gradeId"[^>]*><option value="" selected=""/);
    expect(html).toContain('暂存');
    expect(html).toContain('提交');
  });

  it('只读字段显示继承值但不能编辑，隐藏/未配置字段不进入 DOM', async () => {
    const html = await render();
    expect(html).toMatch(/<input(?=[^>]*name="jobNumber")(?=[^>]*readOnly="")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*name="readonly-note")(?=[^>]*readOnly="")[^>]*>/);
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

  it('开关开启但没有直接调动按钮权限时，同样隐藏两处入口', async () => {
    const html = await render(true, false);
    expect(html).not.toContain('EmploymentRecord.LineOp.Transfer');
    expect(html).not.toContain('Employment.Tranfer');
    expect(html).toContain('提交');
  });

  it('关闭后两处直接调动均消失，申请提交与暂存仍可用', async () => {
    const html = await render(false);
    expect(html).not.toContain('EmploymentRecord.LineOp.Transfer');
    expect(html).not.toContain('Employment.Tranfer');
    expect(html).toContain('提交');
    expect(html).toContain('暂存');
  });
});

describe('AC-TRF-30 / DEC-154：业务冲突保留精确提示', () => {
  it('409 业务冲突显示审批中记录/租户开关提示，只有版本冲突要求刷新', async () => {
    const apiPath = new URL('../../apps/web/src/transfer/api.ts', import.meta.url).pathname;
    const { requestError, TransferApiError } = (await import(apiPath)) as {
      requestError: (error: unknown) => string;
      TransferApiError: new (code: string, message: string, status: number) => Error;
    };
    for (const message of ['当前存在审批中的调动记录，无法进行此操作', '本租户调动须走审批']) {
      expect(requestError(new TransferApiError('CONFLICT', message, 409))).toBe(message);
    }
    expect(requestError(new TransferApiError('REVISION_CONFLICT', '任职数据已变更', 409))).toBe(
      '数据已发生变化。请重新读取表单并核对，再主动提交。',
    );
  });
});

function departmentScenario(
  fields: TransferFormModel['fields'] = {},
  departmentMode: FieldMode = 'editable',
): TransferFormModel {
  const base = model();
  return {
    ...base,
    fields,
    transferTypeCode: 'cross_unit',
    catalog: {
      ...base.catalog,
      types: [{ code: 'cross_unit', name: '跨单位调动', formId: 'TenantBase.InterOrgTransferMultiFormView' }],
    },
    employees: [...base.employees, { id: 'manager-1', name: '部门负责人', code: 'M001', revision: 1 }],
    preview: {
      ...base.preview!,
      form: {
        ...base.preview!.form,
        id: 'TenantBase.InterOrgTransferMultiFormView',
        name: '机构间调入申请',
        excludedAutofillFields: ['departmentId', 'levelId', 'gradeId', 'directManagerId'],
        fieldModes: {
          ...base.preview!.form.fieldModes,
          'preset:departmentId': departmentMode,
          'preset:directManagerId': 'editable',
        },
      },
      fields: {
        ...base.preview!.fields,
        departmentId: departmentMode === 'editable' ? null : 'department-2',
        levelId: null,
        gradeId: null,
        // 新部门负责人可以派生带出，不是所有“不带出”字段都需要 HR 再次确认。
        directManagerId: 'manager-1',
      },
    },
  };
}

async function renderScenario(scenario: TransferFormModel) {
  const { TransferForm } = (await import(componentPath)) as { TransferForm: unknown };
  return renderToStaticMarkup(createElement(TransferForm, { model: scenario }));
}

function actionDisabledStates(html: string) {
  return Object.fromEntries(
    [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((match) => [match[2], /\bdisabled=""/.test(match[1]!)]),
  );
}

const enabledActions = { 提交: false, 暂存: false, 直接调动: false, 为所选员工直接调动: false };

describe('AC-TRF-18 / DEC-163：仅新部门必填，其余不带出字段允许留空', () => {
  it('仅新部门标必填并设置 required，职级、职等、直线经理不误标', async () => {
    const html = await renderScenario(departmentScenario());
    expect(html).toMatch(/<select(?=[^>]*name="departmentId")(?=[^>]*required="")[^>]*>/);
    expect(html).toMatch(/<label>新部门(?:(?!<\/label>)[^])*必填/);
    for (const name of ['levelId', 'gradeId', 'directManagerId']) {
      expect(html).not.toMatch(new RegExp(`<select(?=[^>]*name="${name}")(?=[^>]*required="")[^>]*>`));
    }
    expect(html).toMatch(/<select name="levelId"[^>]*><option value="" selected=""/);
    expect(html).toMatch(/<select name="gradeId"[^>]*><option value="" selected=""/);
  });

  it.each([
    ['未提供新部门', {}],
    ['显式清空新部门', { departmentId: null }],
    ['新部门为空字符串', { departmentId: '' }],
    ['新部门为纯空白', { departmentId: '   ' }],
  ] as const)('%s 时，提交、暂存和两个直接调动入口均禁用', async (_case, fields) => {
    expect(actionDisabledStates(await renderScenario(departmentScenario(fields)))).toEqual({
      提交: true,
      暂存: true,
      直接调动: true,
      为所选员工直接调动: true,
    });
  });

  it.each([
    ['只选择部门，其他字段不填', { departmentId: 'department-2' }],
    ['其余字段显式留空', { departmentId: 'department-2', levelId: null, gradeId: null, directManagerId: null }],
  ] as const)('%s 时可以暂存、提交和直接调动', async (_case, fields) => {
    expect(actionDisabledStates(await renderScenario(departmentScenario(fields)))).toEqual(enabledActions);
  });

  it('非必填直线经理展示部门联动带出的值，显式清空后展示空并原样提交 null', async () => {
    const derived = departmentScenario({ departmentId: 'department-2' });
    const html = await renderScenario(derived);
    expect(html).toMatch(/<option value="manager-1" selected="">部门负责人<\/option>/);
    expect(actionDisabledStates(html)).toEqual(enabledActions);
    const cleared = departmentScenario({ departmentId: 'department-2', directManagerId: null });
    expect(await renderScenario(cleared)).toMatch(/<select name="directManagerId"[^>]*><option value="" selected=""/);
    const apiPath = new URL('../../apps/web/src/transfer/api.ts', import.meta.url).pathname;
    const { previewInput } = (await import(apiPath)) as {
      previewInput: (value: TransferFormModel) => { fields: TransferFormModel['fields'] };
    };
    expect(previewInput(cleared).fields).toEqual({ departmentId: 'department-2', directManagerId: null });
  });

  it.each(['readonly', 'hidden', 'absent'] as const)('部门为 %s 时沿继承矩阵，不增加可编辑必填项', async (mode) => {
    const html = await renderScenario(departmentScenario({}, mode));
    expect(html).not.toContain('必填');
    expect(actionDisabledStates(html)).toEqual(enabledActions);
    if (mode === 'readonly') {
      expect(html).toMatch(/<input(?=[^>]*name="departmentId")(?=[^>]*readOnly="")[^>]*>/);
    } else expect(html).not.toContain('name="departmentId"');
  });
});
