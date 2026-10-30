import type { FormGroup } from '../foundation/FormOverlay.js';
import { RequestControl, requestFieldLabel } from '../part-time/RequestControl.js';
import { refPaths } from '../part-time/references.js';
import { r } from '../part-time/request-messages.js';
import type { RequestKind } from '../part-time/request-model.js';
import { editFields } from './edit-model.js';
import { fieldLabels, messages as m } from './messages.js';
import type { ApprovalAction, ApprovalDetail } from './types.js';

const kinds: Record<string, RequestKind> = {
  part_time_add: 'add',
  part_time_extend: 'extend',
  part_time_end: 'end',
};
/** 这里只映射已实现的控件，不决定节点可编辑字段或必填。未知字段保持只读。 */
export function approvalEditGroup(detail: ApprovalDetail, action: ApprovalAction): FormGroup[] {
  const fields = editFields(detail, action);
  if (!fields.length) return [];
  const kind = kinds[detail.approvalType];
  return [
    {
      title: m.values,
      fields: fields.map(({ key, required, value }) => {
        const field = key === 'partTimeType' ? 'serviceType' : key;
        const supported = !!kind && (['serviceType', 'endDate', 'requestRemark'].includes(field) || !!refPaths[field]);
        const label = kind ? requestFieldLabel(field, kind) : (fieldLabels[key] ?? key);
        return {
          name: key,
          label,
          access: { visible: true, editable: supported },
          control: supported ? <RequestControl field={field} label={label} /> : null,
          display: readonlyValue(value),
          rules: required ? [{ required: true, message: r.required }] : [],
        };
      }),
    },
  ];
}

function readonlyValue(value: unknown) {
  if (value === null || value === undefined) return m.empty;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
