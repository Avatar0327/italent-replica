/** F-301：预览调用方必须显式提供字段可见性，错误参数在任何数据读取前报内部错误。 */
import type { Tx } from '@italent/db';
import { describe, expect, it, vi } from 'vitest';
import { previewExit } from '../../apps/api/src/modules/employment/exit-preview.js';
import type { ExitViewable } from '../../apps/api/src/modules/employment/exit-queries.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';

const LAST_WORK_DATE = '2026-10-15';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000301';
const INVALID_VIEW = 'previewExit 必须显式传入有效的 retirementView';

function unreadableDatabase() {
  const execute = vi.fn().mockRejectedValue(new Error('非法可见性不应读取数据库'));
  return { tx: { execute } as unknown as Tx, ctx: {} as EmploymentContext, execute };
}

describe('AC-RT-F301 retirementView 类型与运行时必传', () => {
  it('AC-RT-F301 省略参数：类型报错，运行时在读库前抛内部错误', async () => {
    const { tx, ctx, execute } = unreadableDatabase();
    // @ts-expect-error F-301：所有调用方必须显式传入 retirementView。
    const result = previewExit(tx, ctx, EMPLOYEE_ID, LAST_WORK_DATE);
    await expect(result).rejects.toThrow(new Error(INVALID_VIEW));
    expect(execute).not.toHaveBeenCalled();
  });

  it('AC-RT-F301 显式 undefined 也不能通过类型或运行时校验', async () => {
    const { tx, ctx, execute } = unreadableDatabase();
    // @ts-expect-error F-301：显式 undefined 不代表有效的字段可见性。
    const result = previewExit(tx, ctx, EMPLOYEE_ID, LAST_WORK_DATE, undefined);
    await expect(result).rejects.toThrow(new Error(INVALID_VIEW));
    expect(execute).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['false', false],
    ['零', 0],
    ['空字符串', ''],
    ['非空字符串', 'all'],
    ['数组', []],
    ['空对象', {}],
    ['缺少 employee 判断函数', { employment: () => false }],
    ['缺少 employment 判断函数', { employee: () => false }],
    ['employee 不是函数', { employee: true, employment: () => false }],
    ['employment 不是函数', { employee: () => false, employment: true }],
  ])('AC-RT-F301 非法值 %s 在读库前抛内部错误', async (_label, value) => {
    const { tx, ctx, execute } = unreadableDatabase();
    const result = previewExit(tx, ctx, EMPLOYEE_ID, LAST_WORK_DATE, value as ExitViewable);
    await expect(result).rejects.toThrow(new Error(INVALID_VIEW));
    expect(execute).not.toHaveBeenCalled();
  });
});
