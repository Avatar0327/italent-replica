/**
 * R2-T04 BE-5d1 / AC-RT-18（纯函数一侧）：五视图口径（docs/08_设计/R2-T04_退休设计.md §10.2）。
 * 固定夹具逐个边界写死期望视图；SQL 一侧的同名边界在 tests/acceptance/AC-RT-18-views.test.ts，再加随机对照。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRetirement,
  type RetirementBillFacts,
  type RetirementPersonFacts,
  type RetirementPersonView,
} from './retirement-views.js';

const ASOF = '2026-10-15';
const DAYS = 30;

const person = (patch: Partial<RetirementPersonFacts> = {}): RetirementPersonFacts => ({
  active: true,
  staffId: 'cycle-1',
  cycleEntryDate: '2026-09-01',
  expectedDate: null,
  ...patch,
});
const bill = (patch: Partial<RetirementBillFacts> = {}): RetirementBillFacts => ({
  id: 'bill-1',
  staffId: 'cycle-1',
  state: 'in_review',
  submitted: true,
  existed: true,
  effectiveDate: '2026-10-26',
  ...patch,
});
const personView = (
  p: Partial<RetirementPersonFacts>,
  bills: RetirementBillFacts[] = [],
  asOf = ASOF,
  upcomingDays = DAYS,
): RetirementPersonView | null => classifyRetirement({ asOf, upcomingDays, person: person(p), bills }).person;
const billViews = (b: Partial<RetirementBillFacts>, asOf = ASOF) =>
  classifyRetirement({ asOf, upcomingDays: DAYS, person: person(), bills: [bill(b)] }).bills[0]!.views;

describe('AC-RT-18 员工行：即将退休 / 过期未退休', () => {
  it.each([
    ['P = asOf 含下端', '2026-10-15', 'upcoming'],
    ['P = asOf + N 含上端', '2026-11-14', 'upcoming'],
    ['P = asOf + N + 1 不进', '2026-11-15', null],
    ['P = asOf − 1 过期', '2026-10-14', 'overdue'],
    ['P = 周期入职日 仍算（P ≥ 入职日）', '2026-09-01', 'overdue'],
    ['P < 周期入职日 排除', '2026-08-31', null],
    ['P 为空', null, null],
  ] as const)('%s', (_name, expectedDate, expected) => {
    expect(personView({ expectedDate })).toBe(expected);
  });

  it('asOf 当天不在职（已退休 / 待入职）不进任何员工视图', () => {
    expect(personView({ active: false, staffId: null, cycleEntryDate: null, expectedDate: '2026-10-20' })).toBeNull();
  });

  it('本周期有流程中或 effective 的退休单 → 排除；草稿 / 驳回 / 不同意 / 作废 / 删除不排除', () => {
    const p = { expectedDate: '2026-10-20' };
    expect(personView(p, [bill({ state: 'in_review' })])).toBeNull();
    expect(personView(p, [bill({ state: 'approved', effectiveDate: '2026-10-21' })])).toBeNull();
    expect(personView(p, [bill({ state: 'effective', effectiveDate: '2026-10-21' })])).toBeNull();
    for (const state of ['draft', 'rejected', 'disapproved', 'voided', 'deleted'])
      expect(personView(p, [bill({ state, submitted: state !== 'draft' })]), state).toBe('upcoming');
  });

  it('流程中必须在 asOf 当日结束前已提交：asOf 之后才提交的单不排除', () => {
    expect(personView({ expectedDate: '2026-10-20' }, [bill({ state: 'in_review', submitted: false })])).toBe(
      'upcoming',
    );
  });

  it('返聘后再次临近退休：旧周期 effective 不排除，新 P 进“即将”；旧 P 早于新周期入职日则不进“过期”', () => {
    const old = bill({ id: 'old', staffId: 'cycle-1', state: 'effective', effectiveDate: '2026-09-20' });
    const reHired = { staffId: 'cycle-2', cycleEntryDate: '2026-10-01' };
    expect(personView({ ...reHired, expectedDate: '2026-10-20' }, [old])).toBe('upcoming');
    expect(personView({ ...reHired, expectedDate: '2026-09-19' }, [old])).toBeNull();
  });
});

describe('AC-RT-18 退休单行：退休中 / 已完成 / 全部', () => {
  it('in_review / approved 且已提交 → 退休中 + 全部', () => {
    expect(billViews({ state: 'in_review' })).toEqual(['processing', 'all']);
    expect(billViews({ state: 'approved' })).toEqual(['processing', 'all']);
  });

  it('草稿、已驳回只在“全部”；未提交的 in_review 同样只在“全部”', () => {
    expect(billViews({ state: 'draft', submitted: false })).toEqual(['all']);
    expect(billViews({ state: 'rejected' })).toEqual(['all']);
    expect(billViews({ state: 'in_review', submitted: false })).toEqual(['all']);
  });

  it('不同意 / 作废 / 删除只在“全部”（被撤销的单任何时点都不进已完成 / 退休中）', () => {
    for (const state of ['disapproved', 'voided', 'deleted']) expect(billViews({ state }), state).toEqual(['all']);
  });

  it('effective：E′ = asOf → 已完成；E′ = asOf + 1 → 退休中（已提交）；E′ = asOf − 1 → 已完成', () => {
    expect(billViews({ state: 'effective', effectiveDate: '2026-10-15' })).toEqual(['completed', 'all']);
    expect(billViews({ state: 'effective', effectiveDate: '2026-10-14' })).toEqual(['completed', 'all']);
    expect(billViews({ state: 'effective', effectiveDate: '2026-10-16' })).toEqual(['processing', 'all']);
  });

  it('asOf 前尚不存在的单不出现在任何视图', () => {
    expect(billViews({ existed: false, submitted: false, state: 'in_review' })).toEqual([]);
  });
});
