// F-132 第 1 段 #326 第 2 轮 P2-4 / P2-6：员工档案“人员信息”按原站分区，日期按“年月日”展示。
// 第 3 轮 P2-1 / P2-2：只按字段类型格式化日期；籍贯与户籍所在地分别对应 registAddress / householdAddress。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { profileSections, longDate, fieldValue } = await import(resolve('apps/web/src/personnel/model.ts'));
const { m } = await import(resolve('apps/web/src/personnel/messages.ts'));
const { FieldGrid } = await import(resolve('apps/web/src/personnel/ProfileSections.tsx'));

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const grid = (row: Record<string, unknown>, fields: string[]) =>
  renderToStaticMarkup(createElement(FieldGrid, { row, fields, allowed: fields }));

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
      'householdAddress',
      'registAddress',
      'officePhone',
      'mobilePhone',
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

describe('AC-FE-R1b-02 第 3 轮 P2-1 日期格式化按字段类型', () => {
  it('形似日期的文本字段（员工ID、证件号码）原样显示，不改写成年月日', () => {
    expect(fieldValue('code', '2026-10-14', 'long')).toBe('2026-10-14');
    expect(fieldValue('idNumber', '2026-10-14', 'long')).toBe('2026-10-14');
    expect(fieldValue('contactAddress', '2026-10-14', 'long')).toBe('2026-10-14');
  });

  it('日期类型字段（人员、入职周期、子集）写成年月日', () => {
    expect(fieldValue('workDate', '2020-07-01', 'long')).toBe('2020年7月1日');
    expect(fieldValue('firstEntryDate', '2024-01-01', 'long')).toBe('2024年1月1日');
    expect(fieldValue('startDate', '2016-09-01', 'long')).toBe('2016年9月1日');
  });

  it('档案字段栅格：员工ID 形似日期时保持原值，出生日期按年月日', () => {
    const html = grid({ id: 'e', code: '2026-10-14', birthday: '2000-03-18' }, ['code', 'birthday']);
    expect(html).toContain('>2026-10-14<');
    expect(html).not.toContain('2026年10月14日');
    expect(html).toContain('>2000年3月18日<');
  });
});

describe('AC-FE-R1b-03 第 3 轮 P2-2 籍贯与户籍所在地', () => {
  it('registAddress 标“籍贯”，householdAddress 标“户籍所在地”，两者都在员工信息分区', () => {
    expect(m.labels.registAddress).toBe('籍贯');
    expect(m.labels.householdAddress).toBe('户籍所在地');
    expect(profileSections[0].fields).toContain('householdAddress');
    expect(profileSections[0].fields).toContain('registAddress');
  });

  it('两者都有值时分别显示在各自标签下', () => {
    const fields = ['householdAddress', 'registAddress'];
    const html = grid({ id: 'e', householdAddress: '合成市甲区', registAddress: '合成省乙县' }, fields);
    expect(html.indexOf('户籍所在地')).toBeLessThan(html.indexOf('合成市甲区'));
    expect(html.indexOf('合成市甲区')).toBeLessThan(html.indexOf('籍贯'));
    expect(html.indexOf('籍贯')).toBeLessThan(html.indexOf('合成省乙县'));
  });
});
