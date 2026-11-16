// F-474-6b 组织自定义字段前端：请求体拼装、列候选、值显示（纯函数，合成数据）。
import { describe, expect, it } from 'vitest';
import { customDisplay } from './custom-fields.js';
import {
  flattenCustomFields,
  orgChangeBody,
  orgCreateBody,
  orgCustomValue,
  pageAccess,
  type OrgRow,
} from './page-model.js';
import { matchOrgColumns, orgColumnOptions, restoreOrgColumns, toggleOrgColumn } from './columns.js';

const A = '30000000-0000-4000-8000-0000000000b1';
const B = '30000000-0000-4000-8000-0000000000b2';
const original: OrgRow = { id: 'o1', revision: 3, name: '合成组织', customFields: { [A]: '甲值' } };
const permission = (viewable: string[], editable: string[] = []) => ({
  objectCode: 'TenantBase.Organization',
  dataOperations: { create: true, update: true },
  viewableFields: viewable,
  editableFields: editable,
  buttons: [],
});

describe('AC-F474-6b-14 请求体：只提交改过的自定义字段，清空为 null', () => {
  it('平铺草稿与嵌套原单取同一份基线；未改不提交，改值、新增、清空各自进 customFields', () => {
    const flat = flattenCustomFields(original);
    expect(flat).toMatchObject({ [`custom:${A}`]: '甲值' });
    expect(flat).not.toHaveProperty('customFields');
    expect(orgCustomValue(original, A)).toBe('甲值');
    expect(orgCustomValue(flat as OrgRow, A)).toBe('甲值');
    expect(orgChangeBody(original, { [`custom:${A}`]: '甲值' }, '2026-10-02')).toEqual({ effectiveDate: '2026-10-02' });
    expect(orgChangeBody(original, { [`custom:${A}`]: '新甲值', [`custom:${B}`]: 7 }, '2026-10-02')).toEqual({
      effectiveDate: '2026-10-02',
      customFields: { [A]: '新甲值', [B]: 7 },
    });
    for (const empty of [undefined, null, '']) {
      expect(orgChangeBody(original, { [`custom:${A}`]: empty }, '2026-10-02').customFields).toEqual({ [A]: null });
      // 本来就没有值：清空不是改动
      expect(orgChangeBody(original, { [`custom:${B}`]: empty }, '2026-10-02')).toEqual({
        effectiveDate: '2026-10-02',
      });
    }
    // 布尔 false 是有效值，不当作空
    expect(orgChangeBody(original, { [`custom:${B}`]: false }, '2026-10-02').customFields).toEqual({ [B]: false });
  });
  it('仅改自定义字段不要求“是否联动任职”选择；改名仍要求', () => {
    expect(() => orgChangeBody(original, { [`custom:${A}`]: 'x' }, '2026-10-02')).not.toThrow();
    expect(() => orgChangeBody(original, { name: '新名' }, '2026-10-02')).toThrow();
  });
  it('新建：自定义字段只发有值的（含 false / 0），放进 customFields', () => {
    const body = orgCreateBody({
      name: ' 新建 ',
      [`custom:${A}`]: '甲',
      [`custom:${B}`]: 0,
      [`custom:cleared`]: undefined,
      [`custom:blank`]: '',
    });
    expect(body).toEqual({ name: '新建', customFields: { [A]: '甲', [B]: 0 } });
    expect(orgCreateBody({ name: '无自定义', [`custom:${A}`]: '' })).toEqual({ name: '无自定义' });
  });
});

describe('AC-F474-6b-15 列与显示：默认不显示、无查看权不出现、空值 --', () => {
  const access = pageAccess(permission(['name', 'code', `custom:${A}`]));
  it('customKeys 只含有查看权的自定义字段；默认列不含自定义字段', () => {
    expect(access.customKeys).toEqual([`custom:${A}`]);
    expect(pageAccess(permission(['name'])).customKeys).toEqual([]);
    expect(restoreOrgColumns().some((key) => key.startsWith('custom:'))).toBe(false);
  });
  it('列候选：有查看权的自定义字段可选；无查看权的键即使传入也被过滤', () => {
    expect(orgColumnOptions(access, [`custom:${A}`, `custom:${B}`])).toEqual(['code', 'name', `custom:${A}`]);
    expect(toggleOrgColumn(['code', 'name'], `custom:${A}`, true)).toEqual(['code', 'name', `custom:${A}`]);
    expect(matchOrgColumns([`custom:${A}`, 'name'], '甲', { [`custom:${A}`]: '合成甲' })).toEqual([`custom:${A}`]);
  });
  it('值显示：下拉显示选项名，布尔是 / 否，空值 --', () => {
    const options = [{ value: 'east', label: '合成东区', enabled: false }];
    expect(customDisplay({ valueType: 'select', options }, 'east')).toBe('合成东区');
    expect(customDisplay({ valueType: 'boolean' }, false)).toBe('否');
    expect(customDisplay({ valueType: 'integer' }, 0)).toBe('0');
    for (const empty of [undefined, null, '']) expect(customDisplay({ valueType: 'text' }, empty)).toBe('--');
  });
});
