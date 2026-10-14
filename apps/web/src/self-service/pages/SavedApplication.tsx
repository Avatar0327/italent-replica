import { Button, Descriptions, Space } from 'antd';
import { useState } from 'react';
import { useRead } from './useRead.js';
import { ReadState } from './parts.js';
import { messages as m } from './messages.js';
import { statusText, valueText } from './model.js';
import { EMPLOYMENT_API, submitSavedTransfer } from '../../transfer/api.js';
import { presetLabels, text as t } from '../../transfer/messages.js';
import type { TransferBusiness } from '../../transfer/types.js';
import type { ApplicationCommandRunner } from '../shared/application-command.js';

type Draft = TransferBusiness & {
  employeeId?: string;
  transferTypeCode?: string;
  reasonCode?: string;
  withEstablishment?: boolean;
};
/** DEC-464：直接展示完整读取结果；缺失值标记未读取，不从已卸载的新建表单补齐。 */
export function SavedApplication({
  id,
  tenantId,
  locked = false,
  run,
}: {
  id: string;
  tenantId: string;
  locked?: boolean;
  run?: ApplicationCommandRunner;
}) {
  const read = useRead<Draft>(`${EMPLOYMENT_API}/businesses/${id}`);
  const [mustRead, setMustRead] = useState(false);
  const draft = read.data;
  const valid = draft?.id === id && Number.isInteger(draft.revision) && typeof draft.status === 'string';
  const submit = async () => {
    if (!draft || !valid || !run || locked || mustRead) return;
    setMustRead(true);
    const commandId = crypto.randomUUID();
    try {
      await run(
        {
          commandId,
          businessId: id,
          employeeId: draft.employeeId ?? m.unread,
          effectiveDate: draft.effectiveDate,
          action: 'submit',
          summary: { revision: draft.revision },
        },
        () => submitSavedTransfer(tenantId, draft, commandId),
      );
    } catch {
      // 页面级入口保留未确认标记或显示确定的拒绝；不自动重试。
    }
  };
  return (
    <section>
      <ReadState state={read} />
      {draft && !valid && <p role="alert">{t.failed}</p>}
      {valid && draft && <Descriptions bordered column={1} items={draftItems(draft)} />}
      <Space>
        <Button
          disabled={read.loading}
          onClick={() => {
            setMustRead(false);
            read.refresh();
          }}
        >
          {locked ? m.queryResult : t.reloadDraft}
        </Button>
        {!locked && valid && draft?.status === 'draft' && (
          <Button
            type="primary"
            disabled={read.loading || mustRead}
            onClick={() => {
              void submit();
            }}
          >
            {t.submitDraft}
          </Button>
        )}
      </Space>
      {locked && <p>{m.readDoesNotConfirm}</p>}
    </section>
  );
}
function draftItems(draft: Draft) {
  const item = (key: string, label: string, value: unknown) => ({
    key,
    label,
    children: <span data-testid={`draft-${key}`}>{value === undefined ? m.unread : valueText(value)}</span>,
  });
  return [
    item('id', m.businessId, draft.id),
    item('revision', m.revision, draft.revision),
    item('status', m.approval, statusText(draft.status)),
    item('employeeId', t.employee, draft.employeeId),
    item('effectiveDate', t.date, draft.effectiveDate),
    item('transferTypeCode', t.type, draft.transferTypeCode),
    item('reasonCode', t.reason, draft.reasonCode),
    item('withEstablishment', t.withEstablishment, draft.withEstablishment),
    ...Object.entries(presetLabels).map(([code, label]) => item(`fields.${code}`, label, draft.fields?.[code])),
    ...Object.entries(draft.fields ?? {})
      .filter(([code]) => !(code in presetLabels))
      .map(([code, value]) => item(`fields.${code}`, code, value)),
    ...(draft.customFields === undefined
      ? [item('customFields', t.custom, undefined)]
      : Object.entries(draft.customFields).map(([code, value]) => item(`custom.${code}`, code, value))),
  ];
}
