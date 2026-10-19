import { describe, expect, it } from 'vitest';
import { MENU_ROUTES } from '../../apps/web/src/foundation/routes.js';
import { typeLabels } from '../../apps/web/src/approval/messages.js';
import { m } from '../../apps/web/src/personnel/messages.js';

describe('AC-FE-R2d1 只读兼职入口与共用文案', () => {
  it('B25～B30 在任职管理应用登记唯一兼职管理入口', () => {
    expect(MENU_ROUTES.filter((route) => route.id === 'part-time')).toMatchObject([
      { app: 'transfer', label: '兼职管理', objectCode: 'TenantBase.EmploymentRecord', path: '/part-time' },
    ]);
  });
  it('B69 档案任职业务类型有兼职中文', () => expect(m.kinds.part_time).toBe('兼职'));
  it('P-37 审批中心识别三类兼职审批', () => {
    expect([typeLabels.part_time_add, typeLabels.part_time_extend, typeLabels.part_time_end]).toEqual([
      '新增兼职',
      '延长兼职',
      '结束兼职',
    ]);
  });
});
