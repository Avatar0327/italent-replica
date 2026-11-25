/**
 * 调动明细的授权与调动表单校验（R2-T08 §6.3，BE-11c-b）：与人工调动（`POST /transfers/employees/:id`）同一条链——
 * normalize → 来源员工（HR 入口按钮、数据范围、不能调自己）→ 任职字段写权 → 预览（目标部门范围、表单规则）→
 * 联动授权（合同、职责转交、组织角色，按新旧选项差异；删除时选项为空、旧联动为 before）。
 * 不判 `mode`（调整单一律按“直接生效”走执行器）、不要求提交 / 确认（`submit` 恒为 false，由审批单驱动）。
 * 联动目标范围（`resolveLinkageAccess`）用的是非事务连接，须在命令事务外先算好传进来，免得 PGlite 单连接下嵌套死锁。
 */
import type { TenantRouteDeps } from '../../routes.js';
import { commandContext } from '../employment/context.js';
import type { EmploymentContext } from '../employment/types.js';
import { requireScopedEmploymentObject } from '../employment/context.js';
import { requireTransferSource } from '../transfer/access.js';
import { authorizeLinkageWrite, type LinkageAccess } from '../transfer/linkage/access.js';
import { normalizeLinkage } from '../transfer/linkage/input.js';
import { previewTransfer } from '../transfer/preview.js';
import { normalizeTransferInput, requireTransferWrite } from '../transfer/service.js';
import type { TransferGate } from './transfer-items.js';

const INITIATOR = 'hr';

export function transferGate(deps: TenantRouteDeps, base: EmploymentContext, access: LinkageAccess): TransferGate {
  return {
    async save(tx, employeeId, raw, before) {
      const ctx = await commandContext(tx, deps, base);
      const input = await normalizeTransferInput(tx, ctx, raw);
      await requireTransferSource(tx, ctx, employeeId, INITIATOR);
      await requireTransferWrite(ctx, input);
      // 目标部门是同单新增组织时没有正式 ID：预览只判已选的部门（未选部门的场景表单允许预览）
      const preview = await previewTransfer(tx, ctx, employeeId, input);
      await requireTransferWrite(preview.context, input);
      await authorizeLinkageWrite(tx, ctx, access, {
        employeeId,
        operation: before ? 'update' : 'create',
        options: input.linkage ?? normalizeLinkage({}),
        before,
      });
      return input;
    },
    async remove(tx, row) {
      const ctx = await commandContext(tx, deps, base);
      await requireTransferSource(tx, ctx, row.employeeId, INITIATOR);
      await authorizeLinkageWrite(tx, ctx, access, {
        employeeId: row.employeeId,
        operation: 'update',
        options: normalizeLinkage({}),
        before: row.linkage,
      });
    },
    async replay(tx, rows) {
      const ctx = await commandContext(tx, deps, base);
      for (const row of rows) {
        await requireTransferSource(tx, ctx, row.employeeId, INITIATOR);
        if (row.departmentId) await requireScopedEmploymentObject(tx, ctx, row.employeeId, row.departmentId);
      }
    },
  };
}
