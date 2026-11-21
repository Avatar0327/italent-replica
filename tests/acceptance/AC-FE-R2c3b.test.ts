import { describe, expect, it } from 'vitest';
import { MODULE_OBJECTS } from '@italent/domain';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { settingsPermission } from '../../apps/web/smoke/exit-fixtures.js';
import {
  formValues,
  parseRules,
  ruleAccess,
  ruleBody,
  saveReceipt,
} from '../../apps/web/src/retirement/settings/model.js';

describe('AC-FE-R2c3b 退休日期规则', () => {
  it('B66 / B67 共用入口按任职记录查看权登记', () => {
    expect(PAGES.entries.find((entry) => entry.path === '/retirement-settings')).toMatchObject({
      app: 'transfer',
      objectCode: MODULE_OBJECTS.employmentRecord.code,
      page: { name: 'RetirementSettingsPage' },
    });
  });

  it('任职设置夹具覆盖整份规则校验的字段，删除动作沿用修改操作', () => {
    expect(settingsPermission.editableFields).toEqual(
      expect.arrayContaining([
        'name',
        'priority',
        'purpose',
        'ruleType',
        'orgIds',
        'includeSubordinates',
        'conditions',
        'enabled',
        'retirementAgeMonths',
        'retirementAgeYears',
        'expectedFunction',
        'earliestFunction',
        'latestFunction',
      ]),
    );
    expect(settingsPermission.dataOperations).toMatchObject({ create: true, update: true, delete: false });
  });

  it('配置字段权缺失时禁止整份保存，其他行操作按对应权限判定', () => {
    const limited = {
      ...settingsPermission,
      editableFields: settingsPermission.editableFields.filter((f) => f !== 'purpose'),
    };
    expect(ruleAccess(limited, true)).toEqual({ create: false, edit: false, copy: true, toggle: true, remove: true });
    expect(ruleAccess(settingsPermission, false)).toEqual({
      create: false,
      edit: false,
      copy: false,
      toggle: false,
      remove: false,
    });
  });

  it('固定年龄提交不带内置函数，弹性范围提交不带年龄，清空可选条件时整份移除', () => {
    const fields = { name: ' 合成规则 ', priority: 1, orgIds: ['org'], employType: ['internal'], gender: [] };
    const fixed = ruleBody('expected_date', 'fixed_age', {
      ...formValues('expected_date'),
      ...fields,
      retirementAgeYears: 55,
      expectedFunction: 'statutory_expected_date',
    });
    expect(fixed).toEqual({
      purpose: 'expected_date',
      ruleType: 'fixed_age',
      orgIds: ['org'],
      name: '合成规则',
      priority: 1,
      retirementAgeYears: 55,
      retirementAgeMonths: 0,
      includeSubordinates: true,
      enabled: true,
      conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
    });
    const flexible = ruleBody('flexible_range', 'builtin', {
      ...formValues('flexible_range'),
      ...fields,
      retirementAgeYears: 55,
    });
    expect(flexible).toMatchObject({ earliestFunction: 'statutory_earliest', latestFunction: 'statutory_latest' });
    expect(flexible).not.toHaveProperty('retirementAgeYears');
  });

  it('列表要求预置和全公司标记，写回执接受裁剪后的真实形态并核对本次版本', () => {
    const raw = {
      ...ruleBody('expected_date', 'fixed_age', {
        ...formValues('expected_date'),
        name: '合成规则',
        priority: 1,
        orgIds: ['org'],
        retirementAgeYears: 55,
      }),
      id: 'rule',
      revision: 2,
    };
    expect(() => parseRules({ items: [raw] }, 'expected_date')).toThrow();
    expect(parseRules({ items: [{ ...raw, allOrgs: false, preset: false }] }, 'expected_date')).toHaveLength(1);
    expect(saveReceipt(raw, 'expected_date', 1, { id: 'rule' })).toEqual({ id: 'rule' });
    expect(() => saveReceipt(raw, 'expected_date', 0, { id: 'rule' })).toThrow();
    expect(() => saveReceipt(raw, 'expected_date', 1, { copiedFrom: 'rule' })).toThrow();
  });
});
