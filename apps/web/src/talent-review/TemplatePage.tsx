import { Alert, Button, Form, Input, Radio, Select, Space, Steps } from 'antd';
import { useEffect, useState } from 'react';
import type { ApiClient, Command } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { equal, type Values } from '../foundation/forms/store.js';
import { useCommandForm, useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { base, readLatest } from './api.js';
import { canOperate, checkReceipt, display, templateWritable } from './model.js';
import { tp, tr } from './messages.js';
import { ReferenceSelect } from './ReferenceSelect.js';
import { objects, type ReviewRecord } from './types.js';

const COLLECTION = `${base}/templates`;
const FIELDS = ['name', 'flowId', 'ownerOrgId', 'downwardPublic', 'enabled'];

/** 模板整页（R3cd spec §2.6）：顶部三步导航，只开放已取证的第一步“基本信息”；编辑先读详情拿最新版本。 */
export function TemplatePage({ id, back }: { id?: string; back(): void }) {
  const api = useApiClient();
  const [state, setState] = useState<{ record?: ReviewRecord; error?: unknown }>({});
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    api
      .request<ReviewRecord>(`${COLLECTION}/${id}`, { signal: controller.signal })
      .then((record) => !controller.signal.aborted && setState({ record }))
      .catch((error: unknown) => !controller.signal.aborted && setState({ error }));
    return () => controller.abort();
  }, [api, id]);
  const record = state.record;
  return (
    <section className="review-template-page">
      <header className="page-heading">
        <h1>{id ? display(record?.name ?? tr.editTemplate) : tr.newTemplate}</h1>
        <Button onClick={back}>{tr.back}</Button>
      </header>
      <Steps className="review-template-steps" current={0} items={tp.steps.map((title) => ({ title }))} />
      {!!state.error && <PageState kind="error" error={state.error} />}
      {id && !record && !state.error && <PageState kind="loading" />}
      {(!id || record) && <TemplateForm key={record?.id ?? 'new'} record={record} saved={back} />}
    </section>
  );
}

function TemplateForm({ record, saved }: { record?: ReviewRecord; saved(): void }) {
  const api = useApiClient();
  const permission = usePermissions(objects.templates);
  const [form] = Form.useForm<Values>();
  const [notice, setNotice] = useState<string>();
  const object = objects.templates;
  const writable = record ? templateWritable(record, permission, object) : canOperate(permission, object, 'create');
  const editable = writable ? FIELDS.filter((field) => permission.field(field).editable) : [];
  // 未确认命令按稳定原单路径存槽，新建用集合路径（DEC-502① e）；FormCommands 在 TalentReviewPage 根部。
  const command = useCommandForm(slotKey(COLLECTION, record?.id));
  const submission = {
    ...command,
    reload: record ? () => command.reread(readLatest(api, COLLECTION, record.id)) : undefined,
  };
  useDraftRefill(submission, editable, form);
  const locked = command.locked || !writable;
  const save = async () => {
    if (locked) return;
    setNotice(undefined);
    try {
      await form.validateFields();
    } catch {
      return;
    }
    const values = form.getFieldsValue(true) as Values;
    // 有没有修改：与内核同一口径；冲突重读并确认后基线是最新记录（DEC-502① b）。
    const state = command.state;
    const baseline = (record && state && state.status !== 'done' ? state.baseline : record) ?? {};
    if (record && !editable.some((field) => !equal(values[field], baseline[field]))) {
      setNotice(tp.noChanges);
      return;
    }
    const result = await command.submit({
      values,
      baseline: record ?? {},
      editableFields: editable,
      revision: record?.revision ?? 0,
      businessId: record?.id,
      patchOnly: !!record,
      send: (sent) => sendTemplate(api, record, sent),
    });
    // 拒绝 / 冲突 / 未知都保留草稿，由 CommandStatus 给出原因与恢复动作。
    if (result.status !== 'done') return;
    command.clear();
    saved();
  };
  return (
    <>
      <CommandStatus submission={submission} labels={tp.columns} />
      {notice && <Alert type="info" showIcon message={notice} />}
      <FormLock locked={locked}>
        <Form form={form} layout="vertical" initialValues={record} disabled={!writable}>
          <TemplateFields editable={(field) => editable.includes(field)} />
        </Form>
      </FormLock>
      <Space className="review-template-footer">
        {writable && (
          <Button type="primary" loading={command.busy} disabled={locked} onClick={() => void save()}>
            {tp.save}
          </Button>
        )}
        <Button disabled title={tr.unverified}>
          {tp.next}
        </Button>
      </Space>
    </>
  );
}

async function sendTemplate(api: ApiClient, record: ReviewRecord | undefined, sent: Command<Values>) {
  const body = { ...sent.body };
  if (typeof body.name === 'string') body.name = body.name.trim();
  if ('flowId' in body && !body.flowId) body.flowId = null;
  const receipt = await api.request<ReviewRecord>(record ? `${COLLECTION}/${record.id}` : COLLECTION, {
    method: record ? 'PATCH' : 'POST',
    command: { ...sent, body },
  });
  return checkReceipt(receipt, record?.id, sent.revision);
}

/**
 * 第一步“基本信息”字段（R3cd spec §2.6）。盘点流程原站标必填，后端只在启用时要求（TEMPLATE_FLOW_REQUIRED），
 * 前端按后端口径校验；描述后端没有字段，只读标未完成。
 */
function TemplateFields({ editable }: { editable(field: string): boolean }) {
  const required = { required: true, message: tr.required };
  const lock = (field: string) => !editable(field);
  return (
    <>
      <Form.Item
        name="name"
        label={tp.columns.name}
        rules={[required, { whitespace: true, max: 50, message: tr.nameRule }]}
      >
        <LockedField disabled={lock('name')}>
          <Input maxLength={50} />
        </LockedField>
      </Form.Item>
      <Form.Item label={tp.columns.flowId} required>
        <Space.Compact block>
          <Form.Item
            name="flowId"
            noStyle
            dependencies={['enabled']}
            rules={[
              ({ getFieldValue }) => ({
                validator: (_, value) =>
                  getFieldValue('enabled') === true && !value
                    ? Promise.reject(new Error(tp.flowRequired))
                    : Promise.resolve(),
              }),
            ]}
          >
            <LockedField disabled={lock('flowId')}>
              <ReferenceSelect path={`${base}/flows`} />
            </LockedField>
          </Form.Item>
          <Button disabled title={tr.unverified}>
            {tp.configure}
          </Button>
        </Space.Compact>
      </Form.Item>
      <Form.Item name="ownerOrgId" label={tp.columns.ownerOrgId} rules={[required]}>
        <LockedField disabled={lock('ownerOrgId')}>
          <ReferenceSelect path="/api/tenant/org/organizations" />
        </LockedField>
      </Form.Item>
      <Form.Item name="downwardPublic" label={tp.columns.downwardPublic} rules={[required]}>
        <LockedField disabled={lock('downwardPublic')}>
          <Radio.Group
            options={[
              { value: true, label: tr.yes },
              { value: false, label: tr.no },
            ]}
          />
        </LockedField>
      </Form.Item>
      <Form.Item name="enabled" label={tp.columns.enabled} rules={[required]}>
        <LockedField disabled={lock('enabled')}>
          <Select
            placeholder={tr.choose}
            options={[
              { value: true, label: tr.enabled },
              { value: false, label: tr.disabled },
            ]}
          />
        </LockedField>
      </Form.Item>
      <Form.Item label={tp.description} extra={tr.unavailable}>
        <Input.TextArea
          disabled
          maxLength={200}
          showCount={{ formatter: ({ count, maxLength }) => `${count}/${maxLength}` }}
        />
      </Form.Item>
    </>
  );
}
