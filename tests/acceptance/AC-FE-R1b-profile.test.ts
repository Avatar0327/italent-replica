// F-132 第 1 段 #326 第 2 轮 P2-4 / P2-6：员工档案“人员信息”按原站分区，日期按“年月日”展示。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { profileSections, longDate, fieldValue } = await import(resolve('apps/web/src/personnel/model.ts'));
const { m } = await import(resolve('apps/web/src/personnel/messages.ts'));

describe('AC-FE-R1b-03 人员信息分区按原站', () => {
  it('人员字段合为一个“员工信息”分区，字段顺序与原站一致', () => {
    expect(profileSections.map((section: { title: string }) => section.title)).toEqual(['员工信息']);
    expect(profileSections[0].fields.slice(0, 18)).toEqual([
      'name',
      'engName',
      'email',
      'educationLevel',
      'workDate',
      'idType',
      'idNumber',
      'birthday',
      'gender',
      'nationality',
      'nation',
      'marryCategory',
      'politicalStatus',
      'householdCategory',
      'registAddress',
      'officePhone',
      'mobilePhone',
      'contactAddress',
    ]);
    expect(m.labels.workDate).toBe('参加工作日期');
    expect(m.labels.nationality).toBe('国籍(地区)');
  });

  it('原有分区里的字段一个不少，且不重复', () => {
    const fields = profileSections[0].fields;
    for (const key of ['code', 'age', 'workEmail', 'backupMail', 'emergencyContact', 'emergencyPhone'])
      expect(fields).toContain(key);
    for (const key of ['lastSchool', 'major', 'graduateDate', 'employeeStatus', 'entryDate', 'firstEntryDate'])
      expect(fields).toContain(key);
    expect(fields).toContain('latestEntryDate');
    expect(fields).toContain('lastWorkDate');
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('AC-FE-R1b-02 档案日期写法', () => {
  it('ISO 日期写成“2021年7月1日”，去掉月日前导零；非日期原样', () => {
    expect(longDate('2021-07-01')).toBe('2021年7月1日');
    expect(longDate('2000-12-18')).toBe('2000年12月18日');
    expect(longDate('DEMO-001')).toBe('DEMO-001');
    expect(fieldValue('birthday', '2000-03-18', 'long')).toBe('2000年3月18日');
    expect(fieldValue('entryDate', '2000-03-18')).toBe('2000-03-18');
  });
});
