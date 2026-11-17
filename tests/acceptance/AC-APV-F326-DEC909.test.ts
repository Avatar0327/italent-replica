/** DEC-909：矩阵单元格类别校验；候选权限以真实 HTTP 核对。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { audits, s4World } from './AC-APV-F326-S7a-support.js';
import { MATRICES, matrix, readMatrix, rejected, replaceMatrixRows } from './AC-APV-F326-S4-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();

describe('DEC-909 矩阵单元格', () => {
  it('② 角色列放部门 ID、部门列放人员 ID 均 400，结构 / revision / 审计不变', async () => {
    const w = await s4World(database().db, 's7d-cell-kind');
    const m = await matrix(w, { rows: [{ cond: [w.child], role: [w.near.userId] }] });
    const beforeAudit = await audits(w, m.id, 'approval.matrix.%');
    const otherTenant = await s4World(database().db, 's7d-other-tenant');
    for (const row of [
      { cond: [w.child], role: [w.child] },
      { cond: [w.near.userId], role: [w.near.userId] },
      { cond: [otherTenant.child], role: [w.near.userId] },
      { cond: [w.child], role: [randomUUID()] },
    ]) {
      await rejected(await replaceMatrixRows(w, m, [row]), 400, 'MATRIX_CELL_KIND_MISMATCH');
      expect(await readMatrix(w, m.id)).toEqual(m);
    }
    expect(await audits(w, m.id, 'approval.matrix.%')).toEqual(beforeAudit);
    // 启停不改变对象类别；资格由运行时决定。
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${w.tenant.id} AND user_id=${w.head.userId}::uuid`),
    );
    const saved = await replaceMatrixRows(w, m, [{ cond: [], role: [w.head.userId] }]);
    expect(saved.status, await saved.clone().text()).toBe(200);
  });

  it('① 仅矩阵权限：矩阵场景 200、设计器 403；无权限账号 403', async () => {
    const w = await s4World(database().db, 's7d-cell-access');
    const user = await w.member('合成矩阵管理员');
    const api = tenantApi(w.db, {
      clock: w.clock,
      authorize: (q) => q.userId === user && q.action === 'admin.process_matrix',
    });
    const paths = [
      '/api/tenant/approval/designer/person-candidates',
      '/api/tenant/approval/designer/source-candidates?type=department&asOf=2026-09-01',
      '/api/tenant/approval/designer/source-candidates?type=position&asOf=2026-09-01',
    ];
    for (const path of paths) {
      const matrixPath = `${path}${path.includes('?') ? '&' : '?'}context=matrix`;
      expect((await api.request('GET', matrixPath, w.as(user))).status).toBe(200);
      expect((await api.request('GET', path, w.as(user))).status).toBe(403);
      expect((await api.request('GET', path, w.as(w.subject.userId))).status).toBe(403);
      expect((await api.request('GET', matrixPath, w.as(w.subject.userId))).status).toBe(403);
    }
    expect((await api.request('GET', MATRICES, w.as(user))).status).toBe(200);
    const editor = tenantApi(w.db, {
      clock: w.clock,
      authorize: (q) => q.userId === user && (q.action === 'admin.process_matrix' || q.action === 'object.update'),
    });
    for (const path of paths) expect((await editor.request('GET', path, w.as(user))).status).toBe(200);
    expect(
      (
        await api.request(
          'GET',
          '/api/tenant/approval/designer/source-candidates?context=matrix&type=public_variable&asOf=2026-09-01',
          w.as(user),
        )
      ).status,
    ).toBe(400);
  });
  it('② 20000 个不同 UUID 仍返回类别 400，不因参数数量溢出返回 500', async () => {
    const w = await s4World(database().db, 's7d-cell-limit');
    const m = await matrix(w, { rows: [] });
    const rows = Array.from({ length: 200 }, () => ({
      cond: [],
      role: Array.from({ length: 100 }, () => randomUUID()),
    }));
    await rejected(await replaceMatrixRows(w, m, rows), 400, 'MATRIX_CELL_KIND_MISMATCH');
    expect(await readMatrix(w, m.id)).toEqual(m);
  });
});
