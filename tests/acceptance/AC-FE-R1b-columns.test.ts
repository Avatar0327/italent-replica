// F-132 第 1 段（#318 P3②）：员工列表“设置显示字段”双栏弹窗的状态规则。
// 原站：左栏勾选全部字段，右栏“已选字段”可拖拽排序、可恢复默认；员工姓名锁定在首位不可取消、不可拖动。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const model = await import(resolve('apps/web/src/personnel/model.ts'));
const {
  columnChoices,
  defaultColumns,
  toggleColumn,
  toggleColumnGroup,
  columnGroupState,
  moveColumn,
  restoreDefaultColumns,
  matchColumns,
  visibleColumns,
} = model;

describe('AC-FE-R1b-columns 设置显示字段', () => {
  it('勾选新字段追加到已选末尾；取消勾选移除；员工姓名不可取消', () => {
    const base = ['name', 'code', 'gender'];
    expect(toggleColumn(base, 'email', true)).toEqual(['name', 'code', 'gender', 'email']);
    expect(toggleColumn(base, 'code', false)).toEqual(['name', 'gender']);
    expect(toggleColumn(base, 'name', false)).toEqual(base);
    // 重复勾选不重复追加；未登记的字段不进入已选
    expect(toggleColumn(base, 'gender', true)).toEqual(base);
    expect(toggleColumn(base, 'unknownField', true)).toEqual(base);
  });

  it('分组全选按候选顺序补齐未选字段，保留已选顺序；全不选只保留员工姓名', () => {
    const keys = ['name', 'code', 'gender', 'email'];
    expect(toggleColumnGroup(['name', 'email'], keys, true)).toEqual(['name', 'email', 'code', 'gender']);
    expect(toggleColumnGroup(['name', 'email', 'mobilePhone'], keys, false)).toEqual(['name', 'mobilePhone']);
  });

  it('分组勾选状态区分全选、部分选、全不选（员工姓名锁定项不计入“部分选”）', () => {
    const keys = ['name', 'code', 'gender'];
    expect(columnGroupState(['name', 'code', 'gender'], keys)).toEqual({ checked: true, indeterminate: false });
    expect(columnGroupState(['name', 'code'], keys)).toEqual({ checked: false, indeterminate: true });
    expect(columnGroupState(['name'], keys)).toEqual({ checked: false, indeterminate: false });
  });

  it('拖拽排序移动到目标位置；员工姓名固定首位，不能被移动也不能被越过', () => {
    const base = ['name', 'code', 'gender', 'email'];
    expect(moveColumn(base, 'email', 'code')).toEqual(['name', 'email', 'code', 'gender']);
    expect(moveColumn(base, 'code', 'email')).toEqual(['name', 'gender', 'email', 'code']);
    expect(moveColumn(base, 'name', 'gender')).toEqual(base);
    expect(moveColumn(base, 'gender', 'name')).toEqual(['name', 'gender', 'code', 'email']);
    expect(moveColumn(base, 'code', 'code')).toEqual(base);
    expect(moveColumn(base, 'missing', 'code')).toEqual(base);
  });

  it('恢复默认回到默认列与默认顺序，返回新数组不共享引用', () => {
    const restored = restoreDefaultColumns();
    expect(restored).toEqual(defaultColumns);
    restored.push('mobilePhone');
    expect(defaultColumns).not.toContain('mobilePhone');
  });

  it('搜索按字段中文名匹配，空关键字返回全部', () => {
    expect(matchColumns(['name', 'code', 'email'], '')).toEqual(['name', 'code', 'email']);
    expect(matchColumns(['name', 'code', 'email', 'entryDate'], '员工')).toEqual(['name', 'code']);
    expect(matchColumns(['name', 'entryDate', 'firstEntryDate'], ' 入职 ')).toEqual(['entryDate']);
  });

  it('列表按已选顺序展示，只显示有查看权的字段', () => {
    expect(visibleColumns(['name', 'email', 'code'], ['name', 'code', 'email'])).toEqual(['name', 'email', 'code']);
    expect(visibleColumns(['name', 'email', 'code'], ['name', 'code'])).toEqual(['name', 'code']);
    expect(columnChoices).toEqual(expect.arrayContaining(defaultColumns));
  });
});
