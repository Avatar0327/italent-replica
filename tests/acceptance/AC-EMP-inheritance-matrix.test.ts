import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { inheritanceFixture } from './AC-EMP-inheritance-support.js';

const testDb = useTestDb();
const kinds = ['regularization', 'transfer', 'intern_regularization', 'org_adjustment', 'leave', 'retirement'] as const;
const cells = [
  { ac: 'AC-EMP-05', inherit: true, formId: 'standard', expected: '上一任职字段值' },
  { ac: 'R7默认继承只读', inherit: true, formId: 'readonly-custom', expected: '上一任职字段值' },
  { ac: 'R7默认继承隐藏', inherit: true, formId: 'hidden-custom', expected: '上一任职字段值' },
  { ac: 'R7默认继承未拖出', inherit: true, formId: 'omitted-custom', expected: '上一任职字段值' },
  { ac: 'AC-EMP-02', inherit: false, formId: 'standard', expected: null },
  { ac: 'AC-EMP-03只读', inherit: false, formId: 'readonly-custom', expected: '上一任职字段值' },
  { ac: 'AC-EMP-03隐藏', inherit: false, formId: 'hidden-custom', expected: '上一任职字段值' },
  { ac: 'AC-EMP-04', inherit: false, formId: 'omitted-custom', expected: null },
] as const;

describe('REQ-EMP-002 R7 每格继承规则覆盖六类非入职业务', () => {
  for (const kind of kinds) {
    it.each(cells)(`${kind}：$ac，表单$formId，继承设置$inherit`, async ({ inherit, formId, expected }) => {
      const fixture = await inheritanceFixture(
        testDb().db,
        `inherit-${kind}-${formId}-${inherit}`,
        inherit,
        kind === 'intern_regularization' ? 'intern' : 'internal',
      );
      const body = {
        kind,
        mode: 'direct',
        formId,
        ...(kind === 'leave' || kind === 'retirement'
          ? { lastWorkDate: '2026-01-31' }
          : { effectiveDate: '2026-02-01' }),
      };
      const preview = await fixture.request('POST', `/employees/${fixture.employee.id}/preview`, { body });
      expect(preview.status).toBe(200);
      const defaults = (await preview.json()) as { customFields: Record<string, unknown> };
      if (formId === 'hidden-custom' || formId === 'omitted-custom') {
        expect(defaults.customFields).not.toHaveProperty(fixture.field.id);
      } else {
        expect(defaults.customFields[fixture.field.id] ?? null).toBe(expected);
      }

      const created = await fixture.business(fixture.employee.id, body, fixture.hired.employeeRevision);
      expect(created.record?.customFields[fixture.field.id] ?? null).toBe(expected);
      expect(created.record?.staffId).toBe(fixture.hired.record?.staffId);
      expect(created.record?.fields).toMatchObject({
        place: '上一任职工作地',
        remarks: '上一任职备注',
        isKeyPerson: true,
      });
      const saved = await fixture.record(created.record!.id);
      expect(saved.customFields[fixture.field.id] ?? null).toBe(expected);
    });
  }
});
