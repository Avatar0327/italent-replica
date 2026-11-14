// F-474-6c 前端：人员自定义字段的键映射、展示、列设置。纯函数，不依赖后端；形状照后端详情 / 列表返回。
import { describe, expect, it } from 'vitest';
import {
  customBody,
  customKey,
  customText,
  flattenCustom,
  selectOptions,
  type CustomDefinition,
} from './custom-model.js';
import { columnLabel, defaultColumns, toggleColumn, toggleColumnGroup } from './model.js';
import { personEditable } from './edit-model.js';
import type { ObjectPermission } from '../foundation/permission-model.js';

const id = '30000000-0000-4000-8000-0000000000b1';
const select: CustomDefinition = {
  id,
  name: '合成地区',
  valueType: 'select',
  options: [
    { value: 'east', label: '合成东区', enabled: true },
    { value: 'old', label: '合成旧区', enabled: false },
  ],
};

describe('AC-FE-F4746c 人员自定义字段', () => {
  it('详情里的 customFields 平铺为 custom:<id>，被裁掉时不造键', () => {
    expect(flattenCustom({ id: 'e', name: 'n', customFields: { [id]: 'east' } })).toEqual({
      id: 'e',
      name: 'n',
      [customKey(id)]: 'east',
    });
    expect(flattenCustom({ id: 'e', name: 'n' })).toEqual({ id: 'e', name: 'n' });
  });

  it('提交体把 custom:<id> 收回 customFields，空值发 null，没有自定义字段时不带该键', () => {
    expect(customBody({ name: 'x', [customKey(id)]: undefined })).toEqual({ name: 'x', customFields: { [id]: null } });
    expect(customBody({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('展示：空值占位，单选显示选项名（含已停用的历史值），布尔与日期按中文写法', () => {
    expect(customText(select, undefined)).toBe('—');
    expect(customText(select, null)).toBe('—');
    expect(customText(select, 'old')).toBe('合成旧区');
    expect(customText({ ...select, valueType: 'boolean' }, false)).toBe('否');
    expect(customText({ ...select, valueType: 'date' }, '2026-02-03')).toBe('2026年2月3日');
    expect(customText({ ...select, valueType: 'integer' }, 0)).toBe('0');
  });

  it('单选候选：停用项只在已选时出现，灰显带后缀', () => {
    expect(selectOptions(select, null).map((o) => o.value)).toEqual(['east']);
    const picked = selectOptions(select, 'old');
    expect(picked.map((o) => [o.value, o.disabled])).toEqual([
      ['east', false],
      ['old', true],
    ]);
    expect(picked[1]!.label).toBe('合成旧区（已停用）');
  });

  it('列设置：自定义列默认不显示，可勾选；名称取定义名', () => {
    expect(defaultColumns.some((key) => key.startsWith('custom:'))).toBe(false);
    expect(toggleColumn(['name'], customKey(id), true)).toEqual(['name', customKey(id)]);
    expect(toggleColumnGroup(['name'], [customKey(id)], true)).toEqual(['name', customKey(id)]);
    expect(columnLabel(customKey(id), { [customKey(id)]: '合成地区' })).toBe('合成地区');
    expect(columnLabel('name', { [customKey(id)]: '合成地区' })).not.toBe('');
  });

  it('编辑入口：只有自定义字段的编辑权也能打开，查看权不算编辑权', () => {
    const permission = (editable: string[]): ObjectPermission => ({
      objectCode: 'TenantBase.EmployeeInformation',
      dataOperations: { update: true },
      viewableFields: [customKey(id), 'name'],
      editableFields: editable,
      buttons: [{ buttonCode: 'update', level: 'detail' }],
    });
    expect(personEditable(permission([customKey(id)]))).toEqual([customKey(id)]);
    expect(personEditable(permission([]))).toEqual([]);
  });
});
