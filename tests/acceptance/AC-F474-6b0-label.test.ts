import { expect, it } from 'vitest';
import { auditObjectMeta } from '../../packages/domain/src/audit/labels.js';

it('AC-F474-10 定义审计显示通用名称，沿用原对象编码与应用', () => {
  expect(auditObjectMeta('employment_custom_field')).toEqual({ label: '自定义字段', app: '组织员工' });
});
