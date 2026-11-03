/**
 * F-366 实习中表头排序（规格 31 末尾 F-366 补充）：只有实习机构 / 实习部门 / 直线经理三列可排；单列排序，
 * 同列点击 升 → 降 → 取消，点另一列直接替换；取消后请求不带排序参数（服务端回到默认顺序）。其余三个页签不排序。
 */
import { INTERN_VIEWS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import * as model from './model.js';

type Sort = { sortBy: string; direction: 'asc' | 'desc' };
const api = model as unknown as {
  listPath(view: string, page: number, filters?: object, sort?: Sort): string;
  sortable(view: string, key: string): boolean;
  nextSort(current: Sort | undefined, key: string): Sort | undefined;
};
const SORTABLE = ['institutionId', 'departmentId', 'directManagerId'];
const query = (path: string) => new URL(path, 'http://localhost').searchParams;

describe('AC-FE-F366 实习中表头排序', () => {
  it('实习中列出实习机构与直线经理两列，请求带上选中的单列排序', () => {
    expect(model.columns.interning).toEqual(expect.arrayContaining(SORTABLE));
    const sorted = query(api.listPath('interning', 1, {}, { sortBy: 'departmentId', direction: 'desc' }));
    expect(sorted.get('sortBy')).toBe('departmentId');
    expect(sorted.get('direction')).toBe('desc');
  });

  it('不排序（含取消后）请求不带 sortBy / direction', () => {
    for (const path of [api.listPath('interning', 1, {}, undefined), api.listPath('interning', 1)]) {
      expect(query(path).has('sortBy')).toBe(false);
      expect(query(path).has('direction')).toBe(false);
    }
  });

  it('只有三列可排；姓名、实习开始日期等其余列与其余页签都不可排', () => {
    const keys = new Set(INTERN_VIEWS.flatMap((view) => [...model.columns[view]]));
    for (const view of INTERN_VIEWS)
      for (const key of keys)
        expect(api.sortable(view, key), `${view}/${key}`).toBe(view === 'interning' && SORTABLE.includes(key));
  });

  it('同列点击 升 → 降 → 取消；点另一列直接替换，不叠加', () => {
    const first = api.nextSort(undefined, 'institutionId');
    expect(first).toEqual({ sortBy: 'institutionId', direction: 'asc' });
    const second = api.nextSort(first, 'institutionId');
    expect(second).toEqual({ sortBy: 'institutionId', direction: 'desc' });
    expect(api.nextSort(second, 'institutionId')).toBeUndefined();
    expect(api.nextSort(second, 'directManagerId')).toEqual({ sortBy: 'directManagerId', direction: 'asc' });
    expect(api.nextSort(first, 'departmentId')).toEqual({ sortBy: 'departmentId', direction: 'asc' });
    const cancelled = api.nextSort(api.nextSort(first, 'institutionId'), 'institutionId');
    expect(query(api.listPath('interning', 1, {}, cancelled)).has('sortBy')).toBe(false);
  });
});
