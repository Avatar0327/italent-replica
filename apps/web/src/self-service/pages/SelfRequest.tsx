import { codeText } from '../../foundation/code-text.js';
import { Alert, Button, Descriptions, Form, Space } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageState } from '../../foundation/index.js';
import { attachmentViews, CarrierAttachments } from '../../foundation/attachments/index.js';
import { rejectionMessage } from '../../foundation/client.js';
import { FormLock, LockedField } from '../../foundation/forms/FormLock.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import type { Values } from '../../foundation/forms/values.js';
import { ExitFields } from '../../exit/ExitFields.js';
import { x } from '../../exit/messages.js';
import { EXIT_ATTACHMENT } from '../../exit/exit-model.js';
import { m as partTime } from '../../part-time/messages.js';
import { RequestControl, requestFieldLabel } from '../../part-time/RequestControl.js';
import { ApprovalProgress } from '../../approval/ApprovalDetail.js';
import type { ApprovalDetail } from '../../approval/types.js';
import { ReadState, ServiceHeading } from './parts.js';
import { useRead } from './useRead.js';
import { useSelfRequest } from './useSelfRequest.js';
import { RequestReference } from './RequestReference.js';
import {
  requestFields,
  requiredRequestFields,
  requestPaths,
  selfRequestValues,
  type RequestFormData,
  type RequestKind,
} from './request-model.js';
import { q } from './request-messages.js';
export function SelfRequest({ kind, id }: { kind: RequestKind; id: string }) {
  const opening = useRead<RequestFormData>(`${requestPaths[kind]}/form`);
  const record = useRead<Values>(id === 'new' ? null : `${requestPaths[kind]}/${encodeURIComponent(id)}`);
  if (!opening.data) return <ReadState state={opening} />;
  if (id !== 'new' && !record.data) return <ReadState state={record} />;
  if (id !== 'new' && record.data?.id !== id) return <PageState kind="error" />;
  return (
    <RequestEditor
      key={`${id}/${record.data?.revision ?? opening.data.employee.revision}`}
      kind={kind}
      opening={opening.data}
      row={record.data}
      refresh={record.refresh}
    />
  );
}
function RequestEditor({
  kind,
  opening,
  row,
  refresh,
}: {
  kind: RequestKind;
  opening: RequestFormData;
  row?: Values;
  refresh(): void;
}) {
  const state = useSelfRequest(kind, opening, row, refresh);
  const { form, permission, locked, baseline } = state;
  const date = Form.useWatch('effectiveDate', form);
  // 附件排队 / 上传中 / 临时文件删除未确认时不得保存或提交（F-479 设计 §5.1“并发”）
  const [busy, setBusy] = useState(false);
  const label = (field: string) =>
    kind === 'exit' ? x.fields[field]! : (q.fields[field] ?? requestFieldLabel(field, 'add'));
  const incomplete = !row && requiredRequestFields[kind].some((key) => !permission.editableFields.includes(key));
  return (
    <section>
      <ServiceHeading title={q.titles[kind]}>
        <Link to="/self/applications">{q.back}</Link>
      </ServiceHeading>
      <p>
        {q.employee}：{opening.employee.name}（{codeText(opening.employee.code)}）
      </p>
      <CommandStatus
        submission={state.command}
        labels={Object.fromEntries(permission.viewableFields.map((key) => [key, label(key)]))}
      />
      {!!state.error && <Alert type="error" message={rejectionMessage(state.error)} />}
      {state.pending && (
        <Alert
          type="warning"
          message={q.unknown}
          action={
            <Button disabled={state.pending.busy} onClick={() => void state.replay()}>
              {state.pending.busy ? q.busy : q.replay}
            </Button>
          }
        />
      )}
      <FormLock locked={locked}>
        <Form form={form} layout="vertical" initialValues={baseline} disabled={locked}>
          {kind === 'exit' ? (
            <ExitFields
              black={false}
              permission={permission}
              editable={permission.editableFields}
              selfOptions={{ reasonCode: q.reasons, whereaboutsCode: q.whereabouts }}
              attachments={{
                ownerId: state.id,
                views: attachmentViews(state.full.attachments),
                // 提交在途只置灰；非草稿 / 已驳回或无编辑权时只读展示缩略图与下载（§5.2）
                readonly: (locked && !state.command.locked) || !permission.editableFields.includes('attachmentRefs'),
                onBusyChange: setBusy,
              }}
            />
          ) : (
            <PartTimeFields state={state} date={date} label={label} />
          )}
        </Form>
      </FormLock>
      <Space>
        <Button disabled={locked || incomplete || busy} onClick={() => void state.run('save')}>
          {q.draft}
        </Button>
        {!!row && (
          <Button type="primary" disabled={locked || state.dirty || busy} onClick={() => void state.run('submit')}>
            {q.submit}
          </Button>
        )}
      </Space>
    </section>
  );
}
function PartTimeFields({
  state,
  date,
  label,
}: {
  state: ReturnType<typeof useSelfRequest>;
  date?: string;
  label(field: string): string;
}) {
  const { permission } = state;
  return (
    <>
      {requestFields.partTime
        .filter((field) => permission.viewableFields.includes(field))
        .map((field) => (
          <Form.Item
            key={field}
            name={permission.editableFields.includes(field) ? field : undefined}
            label={label(field)}
            rules={
              permission.editableFields.includes(field) && requiredRequestFields.partTime.includes(field)
                ? [{ required: true, message: q.required }]
                : []
            }
          >
            {permission.editableFields.includes(field) ? (
              <LockedField>
                {['departmentId', 'directManagerId'].includes(field) ? (
                  <RequestReference key={String(date)} field={field} date={date} />
                ) : (
                  <RequestControl field={field} label={label(field)} />
                )}
              </LockedField>
            ) : (
              <span>
                {field === 'serviceType'
                  ? (partTime.serviceTypes[String(state.full[field]) as keyof typeof partTime.serviceTypes] ?? '—')
                  : String(state.full[field] ?? '—')}
              </span>
            )}
          </Form.Item>
        ))}
    </>
  );
}
export function SelfRequestInfo({ kind, record }: { kind: RequestKind; record: Values }) {
  const values = selfRequestValues(kind, record);
  return (
    <Descriptions
      column={1}
      items={requestFields[kind]
        .filter((key) => values[key] !== undefined)
        .map((key) => ({
          key,
          label: kind === 'exit' ? x.fields[key] : (q.fields[key] ?? requestFieldLabel(key, 'add')),
          children:
            key === 'attachmentRefs' ? (
              <CarrierAttachments
                purpose={EXIT_ATTACHMENT}
                carrier="selfExit"
                ownerId={String(record.id)}
                items={attachmentViews(record.attachments)}
              />
            ) : (
              ([...q.reasons, ...q.whereabouts].find((option) => option.value === values[key])?.label ??
              (key === 'serviceType'
                ? partTime.serviceTypes[String(values[key]) as keyof typeof partTime.serviceTypes]
                : undefined) ??
              String(values[key] ?? '—'))
            ),
        }))}
    />
  );
}
export function SelfApprovalProgress({ id }: { id: string }) {
  const read = useRead<ApprovalDetail>(`/api/tenant/approval/instances/${encodeURIComponent(id)}`);
  return read.data ? <ApprovalProgress detail={read.data} /> : <ReadState state={read} />;
}
