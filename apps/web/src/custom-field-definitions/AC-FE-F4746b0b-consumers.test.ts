// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Form } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmploymentFields } from '../self-service/shared/TransferForm.js';
import { DirectCustomField } from '../part-time/DirectCustomFields.js';
import type { TransferFormModel } from '../transfer/types.js';

// 定义形状照 GET /custom-fields 与调动预览 form.customFields（getCustomFieldsForInheritance）：非 select 也带 options: []。
const select = '30000000-0000-4000-8000-0000000000a1';
const plain = '30000000-0000-4000-8000-0000000000a2';
const options = [
  { value: 'east', label: '合成东区', enabled: true },
  { value: 'west', label: '合成西区', enabled: false },
  { value: 'north', label: '合成北区', enabled: false },
];
const definitions = [
  { id: select, code: 'ext_a1', name: '合成地区', objectType: 'employment', valueType: 'select', revision: 1 },
  { id: plain, code: 'ext_a2', name: '合成备注', objectType: 'employment', valueType: 'text', revision: 1 },
].map((field) => ({ ...field, inherit: true, options: field.valueType === 'select' ? options : [] }));

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function transferModel(): TransferFormModel {
  const values = { [select]: 'west', [plain]: '合成原备注' };
  return {
    employees: [],
    departments: [],
    catalog: { types: [], reasons: [] },
    employeeId: 'synthetic',
    effectiveDate: '2026-11-11',
    transferTypeCode: 'T',
    reasonCode: 'R',
    fields: {},
    customFields: {},
    preview: {
      form: {
        id: 'form',
        name: '合成表单',
        isStandard: true,
        excludedAutofillFields: [],
        fieldModes: { [`custom:${select}`]: 'editable', [`custom:${plain}`]: 'editable' },
        customFields: definitions,
      },
      fields: {},
      customFields: values,
      before: { fields: {}, customFields: values },
      employeeRevision: 1,
      allowDirectTransfer: false,
    },
  };
}

describe('AC-F474-0BFE 现有自定义字段控件消费单选下拉', () => {
  it('AC-F474-0BFE04 调动表单：单选只列启用项和原值停用项，原值显示名称，非单选仍是文本框', async () => {
    const onField = vi.fn();
    await act(async () => root.render(h(EmploymentFields, { model: transferModel(), onField })));
    const control = host.querySelector<HTMLSelectElement>(`select[name="${select}"]`);
    expect(control, '单选下拉控件').not.toBeNull();
    expect([...control!.options].map((option) => [option.value, option.textContent, option.disabled])).toEqual([
      ['', '请选择', false],
      ['east', '合成东区', false],
      ['west', '合成西区（已停用）', true],
    ]);
    expect(control!.value).toBe('west');
    expect(host.querySelector('.transfer-before output')!.textContent).toBe('合成西区');
    const text = host.querySelector<HTMLInputElement>(`input[name="${plain}"]`);
    expect(text?.type).toBe('text');
    expect(text?.value).toBe('合成原备注');
    await act(async () => {
      control!.value = 'east';
      control!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onField).toHaveBeenCalledWith('custom', select, 'east');
  });

  it('AC-F474-0BFE05 兼职表单：单选停用项只在原值时出现且不可选，只读时显示名称', async () => {
    const access = (editable: boolean) => ({ field: () => ({ visible: true, editable }) });
    const render = async (editable: boolean, baseline: Record<string, unknown>) => {
      await act(async () =>
        root.render(
          h(Form, {
            initialValues: baseline,
            children: h(DirectCustomField, {
              field: definitions[0]!,
              access: access(editable) as never,
              create: false,
              baseline,
            } as never),
          }),
        ),
      );
      await settle();
    };
    await render(false, { [`custom:${select}`]: 'west' });
    expect(host.textContent).toContain('合成西区');
    await render(true, { [`custom:${select}`]: 'west' });
    await act(() =>
      host.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    await settle();
    const items = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
    expect(items.map((node) => node.textContent)).toEqual(['合成东区', '合成西区（已停用）']);
    expect(items[1]!.getAttribute('aria-disabled') ?? items[1]!.className).toMatch(/true|disabled/);
  });
});
