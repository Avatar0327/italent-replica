import type { ReactNode } from 'react';
import { editableRows } from '../foundation/forms/values.js';
import { useFormLock } from '../foundation/forms/FormLock.js';
import { Alert, Checkbox, Input, InputNumber, Select, Table } from 'antd';
import { usePermissions } from '../foundation/Permissions.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import { RemoteSelect } from '../evaluation/runtime.js';
import { Repeated } from '../evaluation/ActivityFields.js';
import { records, type Row } from '../evaluation/model.js';
import { m as common, textValue } from '../evaluation/messages.js';
import { questionnaireContent } from './model.js';
import { m, display } from './messages.js';
const OBJECT = 'Survey360.Questionnaire';
export function QuestionnaireEditor({
  path,
  title,
  row,
  close,
  saved,
}: {
  path: string;
  title: string;
  row?: Row;
  close(): void;
  saved(): void;
}) {
  const permission = usePermissions(OBJECT);
  const writer = useRecordForm(path, row, questionnaireValues);
  const current = writer.current;
  const contentFields = ['roles', 'scales', 'dimensions', 'questions'];
  let content: ReturnType<typeof questionnaireContent> | undefined;
  let incomplete = false;
  if (current && contentFields.every((key) => permission.field(key).visible)) {
    try {
      content = questionnaireContent(current);
    } catch {
      incomplete = true;
    }
  }
  const fields = headerFields(permission, current);
  if (row && content)
    fields.push({
      name: 'content',
      label: m.content,
      access: {
        visible: true,
        editable: contentFields.every((key) => permission.field(key).editable),
      },
      control: <ContentEditor used={current?.status === 'used'} latest={content} />,
      display: common.readOnly,
    });
  return (
    <>
      {incomplete && <Alert type="warning" message={m.incomplete} />}
      <FormOverlay
        open
        mode="drawer"
        recordKey={row?.id ?? 'new'}
        submission={writer}
        title={row ? m.edit : title}
        initialValues={row ? { ...row, content } : { type: 'key_behavior', scoreMethod: 'weighted_average' }}
        groups={[{ title: m.basic, fields }]}
        onClose={close}
        onSubmit={async (values) => {
          const draft =
            current?.status === 'used' && content && values.content
              ? { ...values, content: editableContent(content, values.content as Record<string, unknown>) }
              : values;
          await writer.save(
            draft,
            fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name),
            row ? 'PUT' : 'POST',
          );
          writer.clear();
          saved();
          close();
        }}
      />
    </>
  );
}
function ContentEditor({
  value,
  onChange,
  used,
  latest,
}: {
  latest?: Record<string, unknown>;
  value?: Record<string, unknown>;
  onChange?: (value: unknown) => void;
  used: boolean;
}) {
  const lock = useFormLock();
  onChange = lock.guard(onChange);
  const fixed = useFormLock(used);
  const draft = value ?? { roles: [], scales: [], dimensions: [], questions: [] };
  const data: Record<string, unknown> = used && latest ? editableContent(latest, draft) : draft;
  const update = (key: string, next: unknown) => onChange?.({ ...data, [key]: next });
  const create = (kind: string) => {
    const defaults: Record<string, object> = {
      roles: { weight: 1 },
      scales: { name: '', options: [] },
      dimensions: { name: '', weight: 100 },
      questions: { text: '', weight: 1 },
    };
    return { key: crypto.randomUUID(), ...defaults[kind] };
  };
  const selector = (source: string, selected: unknown, set: (v: unknown) => void) => (
    <Select
      allowClear
      value={selected as string}
      disabled={fixed.disabled}
      className="r3b-wide"
      onChange={fixed.guard((v) => set(v ?? null))}
      options={records(data[source]).map((item) => ({ value: String(item.key), label: textValue(item.name) }))}
    />
  );
  return (
    <>
      {used && <Alert message={m.usedHint} type="info" />}
      {['roles', 'scales', 'dimensions', 'questions'].map((kind) => (
        <section key={kind}>
          <h3 className="r3b-section">{m[kind as 'roles']}</h3>
          <Repeated
            value={records(data[kind])}
            onChange={(v) => update(kind, v)}
            create={used ? undefined : () => create(kind)}
            max={kind === 'roles' ? 15 : 100}
          >
            {(item, set) => <ContentFields item={item} set={set} used={used} kind={kind} selector={selector} />}
          </Repeated>
        </section>
      ))}
    </>
  );
}
export function QuestionnairePreview({ row }: { row: Row }) {
  const permission = usePermissions(OBJECT);
  return (
    <>
      {permission.field('guide').visible && <p>{textValue(row.guide)}</p>}
      {['roles', 'dimensions', 'questions', 'scales']
        .filter((key) => permission.field(key).visible)
        .map((key) => (
          <section key={key}>
            <h3 className="r3b-section">{m[key as 'roles']}</h3>
            <Table
              size="small"
              rowKey={(r) => String(r.id ?? r.key)}
              pagination={false}
              dataSource={records(row[key])}
              columns={({ roles: ['roleId', 'weight'], questions: ['text', 'weight'] }[key] ?? ['name', 'weight']).map(
                (field) => ({ title: m[field as 'name'], dataIndex: field, render: textValue }),
              )}
              expandable={
                key === 'scales'
                  ? {
                      expandedRowRender: (scale) => (
                        <div>
                          {records(scale.options).map((option, i) => (
                            <p key={i}>
                              {textValue(option.label)} · {option.notScored ? m.notScored : textValue(option.value)}
                            </p>
                          ))}
                        </div>
                      ),
                    }
                  : undefined
              }
            />
          </section>
        ))}
    </>
  );
}

function headerFields(permission: ReturnType<typeof usePermissions>, row?: Row) {
  const fields: FormField[] = ['name', ...(row ? [] : ['type']), 'scoreMethod', 'guide'].map((name) => ({
    name,
    label: m[name as 'name'],
    access: permission.field(name),
    rules: name === 'name' || name === 'type' ? [{ required: true, message: common.required }] : [],
    control: headerControl(name),
  }));
  return fields;
}

interface ItemProps {
  item: Record<string, unknown>;
  set(key: string, value: unknown): void;
  used: boolean;
}
function ScaleOptions({ item, set, used }: ItemProps) {
  const fixed = useFormLock(used);
  return (
    <Repeated
      value={records(item.options)}
      onChange={(v) => set('options', v)}
      max={15}
      create={used ? undefined : () => ({ key: crypto.randomUUID(), label: '', value: 0 })}
    >
      {(option, setOption) => (
        <>
          <label>
            {m.label}
            <Input value={String(option.label ?? '')} onChange={(e) => setOption('label', e.target.value)} />
          </label>
          <label>
            {m.value}
            <InputNumber
              value={option.value as number}
              onChange={fixed.guard((v) => setOption('value', v))}
              disabled={fixed.disabled}
            />
          </label>
          {['notScored', 'remarkRequired'].map((key) => (
            <Checkbox
              key={key}
              checked={option[key] === true}
              disabled={fixed.disabled}
              onChange={fixed.guard((e) => setOption(key, e.target.checked))}
            >
              {m[key as 'notScored']}
            </Checkbox>
          ))}
        </>
      )}
    </Repeated>
  );
}

function ContentFields({
  item,
  set,
  used,
  kind,
  selector,
}: ItemProps & {
  kind: string;
  selector(source: string, selected: unknown, set: (v: unknown) => void): ReactNode;
}) {
  const fixed = useFormLock(used);
  return (
    <>
      {kind === 'roles' ? (
        <label>
          {m.roleId}
          <RemoteSelect
            path="/api/tenant/survey360/roles"
            value={item.roleId as string}
            onChange={fixed.guard((v) => set('roleId', v))}
            disabled={fixed.disabled}
          />
        </label>
      ) : (
        <label>
          {kind === 'questions' ? m.text : m.name}
          <Input
            value={String(item[kind === 'questions' ? 'text' : 'name'] ?? '')}
            onChange={(e) => set(kind === 'questions' ? 'text' : 'name', e.target.value)}
          />
        </label>
      )}
      {kind !== 'scales' && (
        <label>
          {m.weight}
          <InputNumber min={0} value={item.weight as number} onChange={(v) => set('weight', v)} />
        </label>
      )}
      {kind === 'dimensions' && (
        <label>
          {m.parentKey}
          {selector('dimensions', item.parentKey, (v) => set('parentKey', v))}
        </label>
      )}
      {kind === 'questions' && (
        <label>
          {m.dimensionKey}
          {selector('dimensions', item.dimensionKey, (v) => set('dimensionKey', v))}
        </label>
      )}
      {['dimensions', 'questions'].includes(kind) && (
        <label>
          {m.scaleKey}
          {selector('scales', item.scaleKey, (v) => set('scaleKey', v))}
        </label>
      )}
      {kind === 'scales' && <ScaleOptions item={item} set={set} used={used} />}
    </>
  );
}

function headerControl(name: string) {
  if (name === 'type' || name === 'scoreMethod')
    return (
      <Select
        options={(name === 'type' ? ['key_behavior', 'rating'] : ['weighted_average', 'weighted_sum']).map((value) => ({
          value,
          label: display(value),
        }))}
      />
    );
  if (name === 'guide') return <Input.TextArea rows={3} maxLength={5000} />;
  return <Input maxLength={200} />;
}

function questionnaireValues(row: Row) {
  try {
    return { ...row, content: questionnaireContent(row) };
  } catch {
    // 内容不完整时仍允许改有权编辑的头部字段；不凭空补出内容。
    return row;
  }
}

function editableContent(latest: Record<string, unknown>, draft: Record<string, unknown>) {
  const rows = (key: string, fields: string[]) =>
    editableRows(records(latest[key]), records(draft[key]), 'key', fields);
  return {
    ...latest,
    roles: rows('roles', ['weight']),
    dimensions: rows('dimensions', ['name', 'definition', 'weight']),
    questions: rows('questions', ['text', 'weight']),
    scales: rows('scales', ['name', 'options']).map((scale) => ({
      ...scale,
      options: editableRows(
        records(records(latest.scales).find((s) => s.key === scale.key)?.options),
        records(scale.options),
        'key',
        ['label'],
      ),
    })),
  };
}
