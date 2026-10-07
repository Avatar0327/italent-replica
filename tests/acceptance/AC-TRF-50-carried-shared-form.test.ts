import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = require('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
const web = (file: string) => new URL(`../../apps/web/src/${file}`, import.meta.url).pathname;
function model(fields: string[] = ['withEstablishment']): TransferFormModel & { withEstablishment: boolean } {
  return {
    initiator: 'hr',
    employees: [],
    departments: [],
    catalog: { types: [], reasons: [], viewableFields: fields, editableFields: fields },
    employeeId: 'synthetic-employee',
    effectiveDate: '2026-10-05',
    transferTypeCode: 'cross_department',
    reasonCode: '',
    fields: { departmentId: 'synthetic-department' },
    customFields: {},
    withEstablishment: true,
    preview: {
      form: {
        id: 'F',
        name: '合成调动表单',
        isStandard: true,
        excludedAutofillFields: [],
        fieldModes: {},
        customFields: [],
      },
      fields: {},
      customFields: {},
      before: null,
      employeeRevision: 2,
      allowDirectTransfer: true,
    },
  };
}
it('AC-TRF-50 共用调动表单按字段权限显示带编开关，隐藏或只读不放开编辑', async () => {
  const { TransferForm } = (await import(web('self-service/shared/TransferForm.tsx'))) as { TransferForm: unknown };
  const render = (m: TransferFormModel) => renderToStaticMarkup(createElement(TransferForm, { model: m }));
  expect(render(model())).toContain('name="withEstablishment"');
  expect(render(model([]))).not.toContain('name="withEstablishment"');
  const readonly = model();
  const html = render({ ...readonly, catalog: { ...readonly.catalog, editableFields: [] } });
  expect(html).toMatch(/<input(?=[^>]*name="withEstablishment")(?=[^>]*disabled="")[^>]*>/);
});
it('AC-TRF-50 共用保存载荷保留带编选项；无编辑权不提交该字段，显式 false 保留', async () => {
  const { transferBody } = (await import(web('transfer/api.ts'))) as {
    transferBody: (m: TransferFormModel, action: string) => object;
  };
  expect(transferBody(model(), 'direct')).toMatchObject({ withEstablishment: true });
  expect(transferBody({ ...model(), withEstablishment: false } as TransferFormModel, 'submit')).toMatchObject({
    withEstablishment: false,
  });
  expect(transferBody(model([]), 'submit')).not.toHaveProperty('withEstablishment');
});
