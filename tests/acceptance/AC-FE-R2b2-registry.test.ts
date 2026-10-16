import { expect, it } from 'vitest';
import { annotationOwners, annotations } from '../../apps/web/src/annotations/index.js';
import { MENU_ROUTES } from '../../apps/web/src/foundation/routes.js';

it('AC-FE-R2b2-01 入职管理由本模块自注册到任职应用', () => {
  expect(MENU_ROUTES.find((route) => route.id === 'entries')).toMatchObject({
    app: 'transfer',
    path: '/entries',
    objectCode: 'TenantBase.EmploymentRecord',
    label: '入职管理',
  });
});
it('AC-FE-R2b2-02 决策注释标明原站路径和真实接线边界', () => {
  expect(annotationOwners.entries).toBe('entries');
  expect(annotations.entries?.original).toContain('组织员工 > 任职管理 > 入职管理');
});
