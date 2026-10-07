/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFieldEdits,
  editableLeaf,
  fieldKey,
  fieldLeaves,
  valueDraft,
} from '../../apps/web/src/approval/fields.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const path = resolve('apps/web/src/approval/ApprovalFields.tsx');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AC-APV-UI-05 审批字段编辑边界', () => {
  it('真实点号字段保留为顶层键，真实嵌套字段只构造改动叶子', () => {
    const values = { 'contractChange.endDate': '2027-12-31', contractFields: { number: '旧编号' } };
    const draft = {
      [fieldKey(['contractChange.endDate'])]: { path: ['contractChange.endDate'], value: null },
      [fieldKey(['contractFields', 'number'])]: { path: ['contractFields', 'number'], value: '新编号' },
    };
    expect(fieldLeaves(values).map((leaf) => leaf.path)).toEqual([
      ['contractChange.endDate'],
      ['contractFields', 'number'],
    ]);
    expect(buildFieldEdits(values, draft, ['contractChange.endDate', 'contractFields'])).toEqual({
      'contractChange.endDate': null,
      contractFields: { number: '新编号' },
    });
  });

  it('隐藏或撤权叶子与伪造路径不进入载荷，显式清空也要求当前权限', () => {
    const values = { reason: '原理由', contractFields: { number: '原编号' } };
    const draft = {
      [fieldKey(['reason'])]: { path: ['reason'], value: null },
      [fieldKey(['salary'])]: { path: ['salary'], value: null },
      [fieldKey(['contractFields', 'salary'])]: { path: ['contractFields', 'salary'], value: '50000' },
      [fieldKey(['contractFields', 'number'])]: { path: ['contractFields', 'number'], value: null },
    };
    expect(buildFieldEdits(values, draft, ['reason', 'salary'])).toEqual({ reason: null });
    expect(buildFieldEdits(values, draft, [])).toEqual({});
  });

  it('嵌套字段许可不授权同级字段，路径键区分点号字段与真实嵌套字段', () => {
    expect(editableLeaf(['contractFields', 'number'], ['contractFields.number'])).toBe(true);
    expect(editableLeaf(['contractFields', 'salary'], ['contractFields.number'])).toBe(false);
    expect(fieldKey(['contractFields.number'])).not.toBe(fieldKey(['contractFields', 'number']));
  });

  it('危险的原型字段不显示也不提交，不能用祖先许可恢复', () => {
    const values = JSON.parse('{"reason":"合成值","__proto__":{"polluted":true},"nested":{"constructor":"坏"}}');
    const draft = {
      [fieldKey(['__proto__', 'polluted'])]: { path: ['__proto__', 'polluted'], value: true },
      [fieldKey(['nested', 'constructor'])]: { path: ['nested', 'constructor'], value: null },
      [fieldKey(['reason'])]: { path: ['reason'], value: '合成新值' },
    };
    expect(fieldLeaves(values)).toEqual([{ path: ['reason'], value: '合成值' }]);
    expect(buildFieldEdits(values, draft, ['__proto__', 'nested', 'reason'])).toEqual({ reason: '合成新值' });
    expect(Object.getPrototypeOf({})).not.toHaveProperty('polluted');
  });

  it('UUID字段和列表复用规范化，不合法输入不能生成写载荷', () => {
    const id = 'A0000000-0000-4000-8000-00000000000A';
    const values = { departmentId: id.toLowerCase(), userIds: [id.toLowerCase()] };
    expect(
      buildFieldEdits(
        values,
        {
          [fieldKey(['departmentId'])]: { path: ['departmentId'], value: ` ${id} ` },
          [fieldKey(['userIds'])]: { path: ['userIds'], value: [` ${id} `] },
        },
        ['departmentId', 'userIds'],
      ),
    ).toEqual({});
    expect(() =>
      buildFieldEdits(values, { [fieldKey(['departmentId'])]: { path: ['departmentId'], value: 'bad' } }, [
        'departmentId',
      ]),
    ).toThrow(/UUID/);
  });

  it('primitive数组保留已有元素类型，不能插入对象或未知类型', () => {
    expect(valueDraft('["新值",null]', ['旧值', null])).toEqual(['新值', null]);
    expect(() => valueDraft('[{"salary":50000}]', ['旧值'])).toThrow();
    expect(() => valueDraft('[42]', ['旧值'])).toThrow();
    expect(() => valueDraft('[]', [{ number: '旧值' }])).toThrow();
    expect(valueDraft('12.5', 1)).toBe(12.5);
    expect(() => valueDraft('NaN', 1)).toThrow();
    expect(valueDraft('false', true)).toBe(false);
    expect(
      buildFieldEdits(
        { contracts: [{ number: '合成编号' }] },
        { [fieldKey(['contracts'])]: { path: ['contracts'], value: null } },
        ['contracts'],
      ),
    ).toEqual({});
  });

  it('只返回的原值也展示，但没有当前可见值不会产生编辑入口', async () => {
    const { ApprovalFields } = await import(path);
    const html = renderToStaticMarkup(
      createElement(ApprovalFields, {
        form: {
          values: { reason: '合成新理由', 'contractChange.endDate': '2028-12-31' },
          originals: { reason: '合成原理由', place: '合成原地点' },
          editMode: 'separate',
          editableFields: ['reason', 'place'],
        },
        draft: {},
        onDraft: () => undefined,
      }),
    );
    expect(html).toContain('合成原地点');
    expect(html).toContain('合成原理由');
    expect(html).toContain('2028-12-31');
    expect(html).toContain('aria-label="reason"');
    expect(html).not.toContain('aria-label="place"');
    expect(html).not.toContain('salary');
  });

  it('对象数组与编辑关闭时只展示接口值，不提供泛JSON写入口', async () => {
    const { ApprovalFields } = await import(path);
    const render = (editMode: string) =>
      renderToStaticMarkup(
        createElement(ApprovalFields, {
          form: {
            values: { contracts: [{ number: '合成编号' }], reason: '合成理由' },
            editMode,
            editableFields: ['contracts', 'reason'],
          },
          draft: {},
          onDraft: () => undefined,
        }),
      );
    expect(render('separate')).toContain('合成编号');
    expect(render('separate')).not.toContain('aria-label="contracts"');
    expect(render('none')).not.toContain('<input');
  });

  it('nullable布尔字段沿既有类型编辑，不能把true提交成文本', async () => {
    const values = { isKeyPerson: null, isDepartmentHead: null, isStoreManager: null };
    for (const code of Object.keys(values)) {
      expect(valueDraft('true', null, [code])).toBe(true);
      expect(valueDraft('', null, [code])).toBe(null);
      expect(buildFieldEdits(values, { [fieldKey([code])]: { path: [code], value: true } }, [code])).toEqual({
        [code]: true,
      });
      expect(() => buildFieldEdits(values, { [fieldKey([code])]: { path: [code], value: 'true' } }, [code])).toThrow();
    }
    const { ApprovalFields } = await import(path);
    const html = renderToStaticMarkup(
      createElement(ApprovalFields, {
        form: { values, editMode: 'separate', editableFields: Object.keys(values) },
        draft: {},
        onDraft: () => undefined,
      }),
    );
    expect(html).toContain('<select aria-label="isKeyPerson"');
    expect(html).not.toContain('<input aria-label="isKeyPerson"');
  });

  it('null和空UUID数组可新增，规范化所有UUID且拒绝重复或无效项', async () => {
    const code = 'addedSubordinateIds';
    const id = 'A0000000-0000-4000-8000-00000000000A';
    for (const original of [null, []]) {
      expect(valueDraft(JSON.stringify([` ${id} `]), original, [code])).toEqual([` ${id} `]);
      expect(
        buildFieldEdits({ [code]: original }, { [fieldKey([code])]: { path: [code], value: [` ${id} `] } }, [code]),
      ).toEqual({ [code]: [id.toLowerCase()] });
      expect(() =>
        buildFieldEdits({ [code]: original }, { [fieldKey([code])]: { path: [code], value: [id, id.toLowerCase()] } }, [
          code,
        ]),
      ).toThrow();
      expect(() => valueDraft('[{"hiddenSalary":5}]', original, [code])).toThrow();
    }
    const { ApprovalFields } = await import(path);
    const html = renderToStaticMarkup(
      createElement(ApprovalFields, {
        form: { values: { [code]: [] }, editMode: 'separate', editableFields: [code] },
        draft: {},
        onDraft: () => undefined,
      }),
    );
    expect(html).toContain('aria-label="addedSubordinateIds"');
  });

  it('生效日期不提供清空按钮，伪造null或非法日期不能静默丢弃', async () => {
    const values = { effectiveDate: '2026-11-01' };
    for (const value of [null, '', '0000-01-01', '2026-02-29', '2026-13-01', '2026-1-01', 'invalid'])
      expect(() =>
        buildFieldEdits(values, { [fieldKey(['effectiveDate'])]: { path: ['effectiveDate'], value } }, [
          'effectiveDate',
        ]),
      ).toThrow();
    expect(valueDraft('2028-02-29', values.effectiveDate, ['effectiveDate'])).toBe('2028-02-29');
    const { ApprovalFields } = await import(path);
    const html = renderToStaticMarkup(
      createElement(ApprovalFields, {
        form: { values, editMode: 'separate', editableFields: ['effectiveDate'] },
        draft: {},
        onDraft: () => undefined,
      }),
    );
    expect(html).toContain('type="date"');
    expect(html).not.toContain('清空 effectiveDate');
  });

  it('未知nullable字段用显式JSON标量表达类型，不能补入对象或数组', () => {
    const code = 'custom:a0000000-0000-4000-8000-00000000000a';
    for (const [input, value] of [
      ['"合成文本"', '合成文本'],
      ['12.5', 12.5],
      ['true', true],
      ['null', null],
    ] as const)
      expect(valueDraft(input, null, [code])).toBe(value);
    for (const input of ['unquoted', '{"salary":50000}', '[]', '1e400'])
      expect(() => valueDraft(input, null, [code])).toThrow();
    expect(buildFieldEdits({ [code]: null }, { [fieldKey([code])]: { path: [code], value: true } }, [code])).toEqual({
      [code]: true,
    });
    expect(() =>
      buildFieldEdits({ [code]: null }, { [fieldKey([code])]: { path: [code], value: { salary: 50000 } } }, [code]),
    ).toThrow();
  });
});
