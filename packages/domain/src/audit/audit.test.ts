import { describe, expect, it } from 'vitest';
import {
  addMonths,
  auditContent,
  auditOperationOf,
  auditQueryWindow,
  auditTaskSummary,
  diffAuditFields,
  renderAuditChanges,
  resolveAuditRetention,
} from './index.js';

describe('字段级变更（DEC-019；20 §2）', () => {
  it('只列出变化的业务字段，技术字段（id、revision、时间戳）不进变更内容；嵌套字段展开为 a.b', () => {
    const changes = diffAuditFields(
      { id: 'x', revision: 1, place: '甲地', fields: { departmentId: 'd1', remarks: null } },
      { id: 'x', revision: 2, place: '甲地', fields: { departmentId: 'd2', remarks: '' } },
    );
    expect(changes).toEqual([{ field: 'fields.departmentId', from: 'd1', to: 'd2' }]);
  });

  it('按原站格式渲染：标签取末段字段名，布尔显示是 / 否，空值显示为空', () => {
    const rendered = renderAuditChanges([
      { field: 'fields.departmentId', from: 'd1', to: 'd2', fromText: '甲部门', toText: '乙部门' },
      { field: 'isKeyPerson', from: null, to: true },
    ]);
    expect(auditContent(rendered)).toBe('部门:从【甲部门】修改为【乙部门】；是否关键人员:从【】修改为【是】');
  });

  it('操作类型先看动作名末段，再看前后值', () => {
    expect(auditOperationOf('employment.record.create', { place: '旧' }, { place: '新' })).toBe('create');
    expect(auditOperationOf('employment.record.delete', { place: '旧' }, null)).toBe('delete');
    expect(auditOperationOf('personnel.update', { a: 1 }, { a: 1, deleted: true })).toBe('delete');
    expect(auditOperationOf('grant.revoke', { status: 'active' }, { status: 'revoked' })).toBe('update');
    expect(auditOperationOf('x.y', null, { a: 1 })).toBe('create');
  });
});

describe('查询期与保留期（20 §2、§5 第 4 条）', () => {
  it('租户配置不合法时逐项回落到系统值；查询期不超过保留期', () => {
    expect(resolveAuditRetention({ queryMonths: 7 })).toEqual({ queryMonths: 3, retainMonths: 6 });
    expect(resolveAuditRetention({ queryMonths: 2, retainMonths: 12 })).toEqual({ queryMonths: 2, retainMonths: 12 });
    expect(resolveAuditRetention({ queryMonths: 1.5, retainMonths: 999 })).toEqual({ queryMonths: 3, retainMonths: 6 });
    expect(resolveAuditRetention({ retainMonths: 2 })).toEqual({ queryMonths: 2, retainMonths: 2 });
  });

  it('月份加减在月末截断，与 PostgreSQL 一致', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-10-01', -6)).toBe('2026-04-01');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
  });

  it('默认窗口为最近 queryMonths 个月；越过保留期或跨度过长分别拒绝', () => {
    const retention = { queryMonths: 3, retainMonths: 6 };
    expect(auditQueryWindow('2026-10-01', retention)).toEqual({
      ok: true,
      from: '2026-07-01',
      to: '2026-10-01',
      earliest: '2026-04-01',
    });
    expect(auditQueryWindow('2026-10-01', retention, { from: '2026-03-31', to: '2026-04-30' })).toMatchObject({
      ok: false,
      reason: 'AUDIT_BEYOND_RETENTION',
    });
    expect(auditQueryWindow('2026-10-01', retention, { from: '2026-05-01', to: '2026-09-30' })).toMatchObject({
      ok: false,
      reason: 'AUDIT_QUERY_WINDOW_TOO_LONG',
    });
    expect(auditQueryWindow('2026-10-01', retention, { from: '2026-09-02', to: '2026-09-01' })).toMatchObject({
      ok: false,
      reason: 'AUDIT_INVALID_RANGE',
    });
  });
});

describe('任务级日志汇总文案（20 §3）', () => {
  it('全部成功 / 部分成功 / 全部失败', () => {
    expect(auditTaskSummary('batch_update', { success: 52, failure: 0 })).toEqual({
      result: 'succeeded',
      summary: '52条全部更新成功',
    });
    expect(auditTaskSummary('import', { success: 3, failure: 2 })).toEqual({
      result: 'partial',
      summary: '3条导入成功，2条失败',
    });
    expect(auditTaskSummary('import', { success: 0, failure: 2 }).result).toBe('failed');
  });
});
