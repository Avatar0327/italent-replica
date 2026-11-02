import { describe, expect, it } from 'vitest';
import {
  ageSegment,
  educationTier,
  genderSegment,
  SEGMENT_NONE,
  segmentAverage,
  tenureSample,
  tenureSegment,
  wholeMonths,
} from './segments.js';

const AS_OF = '2026-10-06';

describe('人事分析分段（规格 35 员工结构报表 / B49）', () => {
  it.each([
    ['2026-04-07', 'under6m', '差一天满 6 个月'],
    ['2026-04-06', '6mto1y', '恰满 6 个月'],
    ['2026-04-05', '6mto1y', '满 6 个月又一天'],
    ['2025-10-07', '6mto1y', '差一天满 1 年'],
    ['2025-10-06', '1to2y', '恰满 1 年'],
    ['2025-10-05', '1to2y', '满 1 年又一天'],
    ['2024-10-06', '2to5y', '恰满 2 年'],
    ['2021-10-06', '5to10y', '恰满 5 年'],
    ['2016-10-07', '5to10y', '差一天满 10 年'],
    ['2016-10-06', '10yplus', '恰满 10 年'],
    ['2026-10-06', 'under6m', 'asOf 当天入职'],
    ['2026-10-07', SEGMENT_NONE, '入职日晚于 asOf'],
    [null, SEGMENT_NONE, '没有入职日'],
  ])('司龄：入职 %s → %s（%s）', (entry, key, _case) => {
    expect(tenureSegment(entry, AS_OF)).toBe(key);
  });

  it.each([
    ['2001-10-07', 'under25', '差一天满 25 岁'],
    ['2001-10-06', '25to30', '恰 25 岁'],
    ['2001-10-05', '25to30', '满 25 岁又一天'],
    ['1996-10-07', '25to30', '差一天满 30 岁'],
    ['1996-10-06', '25to30', '恰 30 岁'],
    ['1996-10-05', '25to30', '满 30 岁又一天'],
    ['1995-10-07', '25to30', '差一天满 31 岁'],
    ['1995-10-06', '31to35', '恰 31 岁'],
    ['1985-10-06', '41to50', '恰 41 岁'],
    ['1975-10-07', '41to50', '差一天满 51 岁'],
    ['1975-10-06', '51plus', '恰 51 岁'],
    ['1975-10-05', '51plus', '满 51 岁又一天'],
    [null, SEGMENT_NONE, '没有出生日期'],
  ])('年龄：出生 %s → %s（%s）', (birthday, key, _case) => {
    expect(ageSegment(birthday, AS_OF)).toBe(key);
  });

  it('学历四档：关键字归档，认不出的非空值归“大专及以下”，空值单列', () => {
    expect(
      ['博士研究生', '硕士', '研究生', '本科', '大学本科', '大专', '高中', '', '  ', null].map(educationTier),
    ).toEqual([
      'doctor',
      'master',
      'master',
      'bachelor',
      'bachelor',
      'collegeOrBelow',
      'collegeOrBelow',
      SEGMENT_NONE,
      SEGMENT_NONE,
      SEGMENT_NONE,
    ]);
  });

  it('性别：男 / 女 / 保密，英文别名归并，其它非空原值保留，空值单列', () => {
    expect(['男', ' 女 ', 'male', 'F', '保密', '未知', '', null].map(genderSegment)).toEqual([
      '男',
      '女',
      '男',
      '女',
      '保密',
      '未知',
      SEGMENT_NONE,
      SEGMENT_NONE,
    ]);
  });

  it('整月、平均值与司龄样本：平均 1 位小数四舍五入，没有样本为 null', () => {
    expect(wholeMonths('2026-01-31', '2026-02-28')).toBe(0);
    expect(wholeMonths('2026-01-31', '2026-03-31')).toBe(2);
    expect(segmentAverage([30, 31, 31])).toBe(30.7);
    expect(segmentAverage([1.25, 1.2])).toBe(1.2);
    expect(segmentAverage([])).toBeNull();
    expect(tenureSample('2025-10-06', AS_OF)).toBe(1);
    expect(tenureSample(null, AS_OF)).toBeNull();
  });
});
