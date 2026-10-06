/**
 * DEC-197 字段裁剪的单元行为，以及迁移 0051 的 SQL 差异函数与 @italent/domain diffAuditFields 口径一致
 * （集合 SQL 写入与历史行回填走 SQL，统一入口走 TypeScript，两边必须得出相同的字段差异）。
 */
import { randomUUID } from 'node:crypto';
import { createTenant, sql, withTenant } from '@italent/db';
import { diffAuditFields } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { visibleChanges, visibleErrorReport, visibleValue } from './visibility.js';

const testDb = useTestDb();

describe('字段裁剪', () => {
  const fields = new Set(['place', 'departmentId', 'custom:abc']);

  it('差异按末段字段编码裁剪；自定义字段两种写法都识别', () => {
    const changes = [
      { field: 'place', from: 'a', to: 'b' },
      { field: 'remarks', from: 'x', to: 'y' },
      { field: 'fields.departmentId', from: 'd1', to: 'd2' },
      { field: 'customFields.abc', from: 1, to: 2 },
      { field: 'custom:abc', from: 1, to: 3 },
      { field: 'customFields.zzz', from: 1, to: 2 },
    ];
    expect(visibleChanges(changes, fields).map((c) => c.field)).toEqual([
      'place',
      'fields.departmentId',
      'customFields.abc',
      'custom:abc',
    ]);
    expect(visibleChanges(changes, undefined)).toHaveLength(6);
  });

  it('前后值逐层裁剪，空容器去掉；不限字段时原样返回', () => {
    const value = { place: 'a', remarks: 'x', fields: { departmentId: 'd', secret: 's' }, customFields: { zzz: 1 } };
    expect(visibleValue(value, fields)).toEqual({ place: 'a', fields: { departmentId: 'd' } });
    expect(visibleValue(value, undefined)).toBe(value);
  });

  it('任务错误报告只留行号、错误码、原因与可见字段', () => {
    const report = [{ rowIndex: 0, errorCode: 'CONFLICT', reason: 'X', code: 'ORG-1', sourceCode: 'S-1' }];
    expect(visibleErrorReport(report, fields)).toEqual([{ rowIndex: 0, errorCode: 'CONFLICT', reason: 'X' }]);
    expect(visibleErrorReport(report, new Set(['code']))).toEqual([
      { rowIndex: 0, errorCode: 'CONFLICT', reason: 'X', code: 'ORG-1' },
    ]);
  });
});

describe('SQL 与 TypeScript 的字段差异口径一致', () => {
  const samples: [unknown, unknown][] = [
    [
      { place: '旧', remarks: '同' },
      { place: '新', remarks: '同' },
    ],
    [null, { name: '新部门', code: 'D1', revision: 1, id: 'x' }],
    [{ fields: { departmentId: 'a', place: '' }, revision: 1 }, { fields: { departmentId: 'b', place: null } }],
    [{ value: { deep: { x: 1 } } }, { value: { deep: { x: 2 } } }],
    [{ orderCode: 3 }, { orderCode: null }],
    [
      { tags: ['a', 'b'], ok: true },
      { tags: ['a'], ok: false },
    ],
  ];

  it.each(samples.map((pair, index) => [index, ...pair]))('样例 %i', async (_index, before, after) => {
    const result = await testDb().db.execute(
      sql`SELECT audit_jsonb_diff(${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb) AS diff`,
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { diff: unknown }[];
    expect(rows[0]!.diff).toEqual(diffAuditFields(before, after));
  });
});

describe('归属推导的每个分支都能执行（plpgsql 只在首次执行时检查列名）', () => {
  const types = [
    'employment-record',
    'employment-business',
    'transfer-request',
    'employment_employee',
    'personnel-order-code',
    'TenantBase.EmploymentContract',
    'TenantBase.Education',
    'organization',
    'establishment-capacity',
    'positions',
    'posts',
    'approval-instance',
    'approval-task',
    'tenant_setting',
  ];

  it.each(types)('%s', async (objectType) => {
    const { db } = testDb();
    const meta = { actorUserId: null, commandId: `anchor-${objectType.replace(/[^A-Za-z0-9]/g, '-')}` };
    const code = `anchor-${objectType.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const tenant = await createTenant(db, { code, name: '归属推导租户' }, meta);
    const id = randomUUID();
    const rows = await withTenant(db, tenant.id, async (tx) => {
      const result = await tx.execute(
        sql`SELECT * FROM audit_scope_anchor(${objectType}, ${id}, NULL, ${JSON.stringify({ employeeId: id })}::jsonb)`,
      );
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
    });
    expect(rows).toHaveLength(1);
  });
});
