import { describe, expect, it } from 'vitest';
import { acceptCreateReceipt, createBody, docKey, validateCreate } from './create-model.js';

const base = {
  name: '合成员工',
  code: 'IN-PROFILE',
  loginEmail: 'login@example.com',
  effectiveDate: '2026-10-12',
  departmentId: 'department',
  companyId: 'company',
  typeId: 'type',
  endDate: '2027-10-11',
};
const profile = {
  backupMail: 'personal@example.com',
  mobilePhone: 'SYNTHETIC-PHONE',
  gender: 'female',
  birthday: '2003-02-04',
  engName: 'Synthetic Intern',
  idType: 'id_card',
  idNumber: 'SYNTHETIC-ID',
  dailyWageStandard: '123456789012.34',
  educationLevel: '合成本科',
  lastSchool: '合成大学',
  major: '合成专业',
  graduateDate: '2026-06-30',
};
const selected = { candidate: { employeeId: 'employee', endKind: 'leave' as const }, revision: 5 };
const validate = (extra: Record<string, unknown>) => {
  const values = { ...base, ...extra };
  validateCreate(values, Object.keys(values), false, false);
};

describe('AC-FE-R2d4 / DEC-684⑧ 员工资料一体写入', () => {
  it('全字段放入同一 profile，个人邮箱与登录邮箱分离，未知键不透传', () => {
    const body = createBody({ ...base, ...profile, accidental: '不透传' }, undefined, false);
    expect(body.profile).toEqual(profile);
    expect(body.loginEmail).toBe(base.loginEmail);
    expect(body).not.toHaveProperty('accidental');
    expect(body).not.toHaveProperty('backupMail');
  });
  it('证件入档和查重使用同一归一化输入', () => {
    const values = { ...base, idType: ' id_card ', idNumber: ' SYNTHETIC-ID ' };
    const body = createBody(values, undefined, false);
    expect(body.profile).toEqual({ idType: 'id_card', idNumber: 'SYNTHETIC-ID' });
    expect(docKey(body.profile as Record<string, unknown>)).toBe(docKey(values));
  });
  it('重聘仅提供的字段覆盖、未提供保留、空串和 null 显式清空', () => {
    expect(
      createBody(
        {
          ...base,
          backupMail: 'new@example.com',
          mobilePhone: undefined,
          gender: null,
          engName: '',
          dailyWageStandard: '',
        },
        selected,
        false,
      ),
    ).toMatchObject({
      kind: 'rehire',
      employeeId: 'employee',
      profile: { backupMail: 'new@example.com', gender: null, engName: null, dailyWageStandard: null },
    });
    expect(createBody({ ...base, mobilePhone: undefined }, selected, false)).not.toHaveProperty('profile');
  });
  it.each(['2026-06-30', null])('毕业日期单填 %s 阻止提交，不偷偷创建教育记录', (graduateDate) => {
    expect(() => validate({ graduateDate })).toThrow(/毕业日期/);
  });
  it.each(['educationLevel', 'lastSchool', 'major'])('提供 %s 即可随同毕业日期提交', (key) => {
    expect(() => validate({ [key]: '合成教育信息', graduateDate: '2026-06-30' })).not.toThrow();
  });
  it.each(['-1', '1.234', '1e2', '.2', '1000000000000', 12.34])('拒绝非法工资 %s', (dailyWageStandard) => {
    expect(() => validate({ dailyWageStandard })).toThrow(/日工资标准/);
  });
  it.each(['0', '0.00', '123456789012.34', '001.20', null, ''])(
    '工资 %s 保持十进制字符串或可空',
    (dailyWageStandard) => {
      expect(() => validate({ dailyWageStandard })).not.toThrow();
      expect(
        (createBody({ ...base, dailyWageStandard }, undefined, false).profile as Record<string, unknown>)
          .dailyWageStandard,
      ).toBe(dailyWageStandard === '' ? null : dailyWageStandard);
    },
  );
  it.each([undefined, {}, { backupMail: 'personal@example.com' }])('允许 profile 按查看权缺省或裁剪 %j', (visible) => {
    const receipt = {
      id: 'business',
      businessId: 'business',
      employeeId: 'employee',
      revision: 1,
      kind: 'hire',
      view: 'interning',
      contract: {
        stage: 'formal',
        id: 'contract',
        companyId: base.companyId,
        startDate: base.effectiveDate,
        endDate: base.endDate,
      },
      ...(visible === undefined ? {} : { profile: visible }),
    };
    expect(acceptCreateReceipt(receipt, createBody({ ...base, ...profile }, undefined, false), 0)).toEqual(receipt);
  });
});
