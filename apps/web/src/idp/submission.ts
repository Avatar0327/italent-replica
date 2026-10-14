import { useMemo } from 'react';
import type { FormField } from '../foundation/FormOverlay.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';
import { createBlocked, rereadDraft } from './access.js';

/**
 * 本片表单接入提交内核的唯一出口（流程、计划、模板三张表单都经这里）：
 * 冲突重读后按 rereadDraft 回填表单值，新增时必填字段不可提交则锁定保存（access.ts 四、五）。
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
  const key = submittable.join('\n');
  const { state } = writer;
  const { values, latest, editedFields } = state ?? {};
  // 依赖只取引用与可提交字段名，表单值引用稳定，FormOverlay 才不会每次渲染都重新回填
  const draft = useMemo(
    () =>
      values &&
      rereadDraft({ values, latest: latest?.values, edited: editedFields ?? [], submittable: key.split('\n') }),
    [values, latest, editedFields, key],
  );
  const blocked = creating && createBlocked(required, submittable);
  return {
    ...writer,
    state: state && draft && { ...state, values: draft },
    locked: writer.locked || blocked,
  };
}
