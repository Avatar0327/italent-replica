/** F-049 第 2 轮 P2-01：adapt 的领域值保留类型，无钩子的日期文本叠加保持兼容。 */
import {
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  parseDateText,
  type BatchEvaluationHooks,
  type ComputationItem,
  type ExprValue,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR } from './AC-EXP-support.js';

const dateField = '盘点对象.日期';
const copiedField = '盘点对象.副本';
const numberField = '盘点对象.数值';
const item = (field: string, priority: number, formula: string): ComputationItem => ({ field, priority, formula });
const people = [inMemorySubject('s1', {})];
const dateValue: ExprValue = { kind: 'date', value: parseDateText('2026-10-08')! };
const fieldKind = (path: string) => (path === dateField ? ('date' as const) : undefined);
const context = { calendar: CALENDAR, fieldKind };

describe('AC-EXP-12 adapt 保留日期类型', () => {
  it('日期文本适配为日期后，ToNumber 与读取器直接给日期一样失败', () => {
    const batch = evaluateBatch(
      [item(dateField, 1, '"2026-10-08"'), item(numberField, 2, `ToNumber(${dateField})`)],
      people,
      context,
      { adapt: (entry, _id, value) => ({ ok: true, value: entry.field === dateField ? dateValue : value }) },
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.s1?.[dateField]).toEqual({ ok: true, value: dateValue });
    const direct = evaluateFormula(`ToNumber(${dateField})`, {
      ...context,
      subject: inMemorySubject('s1', { [dateField]: new Date('2026-10-07T16:00:00Z') }),
    });
    expect(direct).toMatchObject({ ok: false, failure: { code: 'TYPE_CONVERSION' } });
    expect(batch.results.s1?.[numberField]).toEqual(direct);
  });

  it('直接引用适配的日期仍是 date，目录声明不把它重新当作文本读取', () => {
    const batch = evaluateBatch(
      [item(dateField, 1, '"2026-10-08"'), item(copiedField, 2, dateField)],
      people,
      context,
      {
        adapt: (entry, _id, value) => ({ ok: true, value: entry.field === dateField ? dateValue : value }),
      },
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.s1?.[copiedField]).toEqual({ ok: true, value: dateValue });
  });

  it.each(['2026-10', '2026-10-08', '13:14:15', '2026-10-08 13:14:15'])(
    '日期精度 %s 与租户墙上时间经过两层依赖仍保留',
    (text) => {
      const adapted: ExprValue = { kind: 'date', value: parseDateText(text)! };
      const batch = evaluateBatch(
        [item(dateField, 1, '"input"'), item(copiedField, 2, dateField), item('盘点对象.末层', 3, copiedField)],
        people,
        { calendar: { ...CALENDAR, timeZone: 'America/Chicago' } },
        { adapt: (entry, _id, value) => ({ ok: true, value: entry.field === dateField ? adapted : value }) },
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      expect(batch.results.s1?.['盘点对象.末层']).toEqual({ ok: true, value: adapted });
    },
  );

  it.each([undefined, {}, { population: people }] satisfies (BatchEvaluationHooks | undefined)[])(
    '无 adapt（%j）保留旧日期文本叠加及 ToNumber 返回 0 的行为',
    (hooks) => {
      const batch = evaluateBatch(
        [
          item(dateField, 1, 'ToDate("2026-10-08")'),
          item(copiedField, 2, dateField),
          item(numberField, 2, `ToNumber(${dateField})`),
        ],
        people,
        context,
        hooks,
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      expect(batch.results.s1?.[dateField]).toEqual({ ok: true, value: dateValue });
      expect(batch.results.s1?.[copiedField]).toEqual({ ok: true, value: { kind: 'text', value: '2026-10-08' } });
      expect(batch.results.s1?.[numberField]).toEqual({ ok: true, value: { kind: 'number', value: 0 } });
    },
  );

  it.each([
    { kind: 'number', value: 2.35 },
    { kind: 'option', value: '3', label: '高' },
    { kind: 'option', value: 3 },
    { kind: 'text', value: '42' },
    { kind: 'boolean', value: false },
    { kind: 'empty', of: 'date' },
  ] satisfies ExprValue[])('其他适配值 %j 经过两层依赖类型和值不变', (adapted) => {
    const batch = evaluateBatch(
      [item('盘点对象.a', 1, '1'), item('盘点对象.b', 2, '盘点对象.a'), item('盘点对象.c', 3, '盘点对象.b')],
      people,
      { calendar: CALENDAR },
      { adapt: (entry, _id, value) => ({ ok: true, value: entry.field === '盘点对象.a' ? adapted : value }) },
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.s1?.['盘点对象.c']).toEqual({ ok: true, value: adapted });
  });
});
