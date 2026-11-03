import { expect, it } from 'vitest';
import { tenureYears } from './roster.js';
import { tenureSample, tenureSegment } from './segments.js';
import { withinOneMonth } from '../analytics/hr-movement.js';

it('AC-EMP-F432-05 / DEC-793：累计司龄先加校正再舍位，分段与短期离职使用校正值', () => {
  const years = tenureYears as (from: string | null, end: string, correction?: number) => string | null;
  const sample = tenureSample as (from: string | null, end: string, correction?: number) => number | null;
  const segment = tenureSegment as (from: string | null, end: string, correction?: number) => string;
  const early = withinOneMonth as (from: string | null, end: string, correction?: number) => boolean;
  expect(years('2025-07-20', '2026-10-01', 2)).toBe('3.2');
  expect(years('2026-10-01', '2026-10-01', 0.29)).toBe('0.2');
  expect(years('2026-09-01', '2026-10-01', 0.02)).toBe('0.1');
  expect(sample('2025-07-20', '2026-10-01', 2)).toBe(3.2);
  expect(segment('2025-07-20', '2026-10-01', 2)).toBe('2to5y');
  expect(segment('2026-04-02', '2026-10-01', 0)).toBe('6mto1y');
  expect(early('2026-09-01', '2026-09-15', 2)).toBe(false);
  expect(early('2026-09-01', '2026-09-15', 0)).toBe(true);
});
