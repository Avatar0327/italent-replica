import { describe, expect, it } from 'vitest';
import { MODULE_OBJECTS } from '@italent/domain';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { settingsPermission } from '../../apps/web/smoke/exit-fixtures.js';

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
});
