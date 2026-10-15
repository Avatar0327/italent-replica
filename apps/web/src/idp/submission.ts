import type { FormField } from '../foundation/FormOverlay.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';
import { createBlocked } from './access.js';

/**
 * 本片表单接入提交内核的唯一出口（流程、计划、模板三张表单都经这里）：
 * 新增时必填字段不可提交则锁定保存（access.ts 五）。冲突重读后的回填由 FormOverlay 经内核 refillDraft 完成（F-142）。
 * 只包装交给 FormOverlay 的视图，不改内核状态；提交仍由 writer.save / writer.submit 发出。
 */
export function useGuardedSubmission<W extends CommandForm>(
  writer: W,
  fields: readonly FormField[],
  { creating, required }: { creating: boolean; required: readonly string[] },
): W {
  const submittable = fields
    .filter((field) => field.access.visible && field.access.editable)
    .map((field) => field.name);
  const blocked = creating && createBlocked(required, submittable);
  return { ...writer, locked: writer.locked || blocked };
}
