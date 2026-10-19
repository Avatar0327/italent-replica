import { Alert, Button, Descriptions, Form, Input, Select, type FormInstance } from 'antd';
import { useEffect, useState, type MutableRefObject } from 'react';
import { RefSelect, NameOf } from '../contracts/references.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { LockedField } from '../foundation/forms/FormLock.js';
import type { Values } from '../foundation/forms/values.js';
import { newCommand, rejectionMessage } from '../foundation/client.js';
import { apiRoot, value, type Row } from './model.js';
import { refPaths } from './references.js';
import { m } from './messages.js';
import { d } from './direct-messages.js';
import { directBody } from './direct-model.js';
import { useDirectApi } from './direct-api.js';
import type { useDirectAccess } from './direct-commands.js';
export function DirectField({
  name,
  create,
  access,
  required,
  baseline,
}: {
  name: string;
  create: boolean;
  access: ReturnType<typeof useDirectAccess>;
  required?: boolean;
  baseline: Values;
}) {
  const field = access.field(name, create);
  if (!field.visible) return null;
  const label = d.labels[name]!;
  if (!field.editable)
    return (
      <Form.Item label={label}>
        <span>
          {name === 'serviceType' ? (m.serviceTypes[String(baseline[name])] ?? m.missing) : value(baseline[name])}
        </span>
      </Form.Item>
    );
  const control = directControl(name, label);
  return (
    <Form.Item name={name} label={label} rules={required ? [{ required: true, message: d.required(label) }] : []}>
      <LockedField>{control}</LockedField>
    </Form.Item>
  );
}
function directControl(name: string, label: string) {
  const path = name === 'employeeId' ? '/api/tenant/personnel/employees' : refPaths[name];
  if (path) return <RefSelect path={path} ariaLabel={label} />;
  if (name === 'serviceType')
    return (
      <Select aria-label={label} options={Object.entries(m.serviceTypes).map(([value, label]) => ({ value, label }))} />
    );
  if (['effectiveDate', 'endDate'].includes(name)) return <TenantDatePicker />;
  return <Input aria-label={label} />;
}
const previewFields = ['employeeId', 'serviceType', 'effectiveDate', 'departmentId', 'postId', 'endDate'];
export function useDirectPreview(
  form: FormInstance,
  values: Values,
  enabled: boolean,
  editable: string[],
  manual: MutableRefObject<Set<string>>,
) {
  const send = useDirectApi();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; error?: unknown; warnings?: Values[] }>();
  const previewKeys = [...previewFields, ...editable.filter((key) => key.startsWith('custom:'))];
  const key = JSON.stringify([...previewKeys.map((key) => values[key]), editable, retry]);
  const valid = enabled && ['employeeId', 'serviceType', 'effectiveDate', 'departmentId'].every((key) => values[key]);
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const inputs = Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) => editable.includes(key) && value !== undefined && value !== null && value !== '',
      ),
    );
    for (const field of ['directManagerId', 'sequenceId']) {
      if (!manual.current.has(field)) delete inputs[field];
      else if (editable.includes(field)) inputs[field] = values[field] ?? null;
    }
    const timer = setTimeout(
      () =>
        void send(
          `${apiRoot}/employees/${values.employeeId}/part-times/preview`,
          'POST',
          newCommand(directBody(inputs, true)),
          controller.signal,
        ).then(
          (result) => {
            if (controller.signal.aborted) return;
            const fields = result.fields as Values | undefined;
            for (const field of ['directManagerId', 'sequenceId'])
              if (editable.includes(field) && !manual.current.has(field))
                form.setFieldValue(field, fields?.[field] ?? null);
            setState({ key, warnings: result.warnings as Values[] });
          },
          (error: unknown) => {
            if (!controller.signal.aborted) setState({ key, error });
          },
        ),
      150,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // key 固定预览依赖，默认值回填不能触发自身再次预览。
  }, [key, valid, send, form]);
  const current = state?.key === key ? state : undefined;
  return {
    busy: !!valid && !current,
    error: current?.error,
    node: (
      <>
        {current?.error ? (
          <Alert
            type="error"
            message={rejectionMessage(current.error)}
            action={<Button onClick={() => setRetry((n) => n + 1)}>{d.retry}</Button>}
          />
        ) : null}
        {current?.warnings?.map((warning) => (
          <Alert
            key={String(warning.reason)}
            type="warning"
            message={d.reasons[String(warning.reason)] ?? String(warning.reason)}
          />
        ))}
      </>
    ),
  };
}
export function ReadonlyPerson({ id }: { id: string }) {
  const api = useApiClient();
  const [state, setState] = useState<{ id: string; person?: Values; primary?: Values; error?: unknown }>();
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const read = async () => {
      const person = await api.request<Values>(`/api/tenant/personnel/employees/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      let primary: Values | undefined;
      for (let page = 1; page <= 10; page++) {
        const result = await api.request<{ items: Row[] }>(
          `${apiRoot}/employees/${encodeURIComponent(id)}/records?page=${page}&pageSize=200`,
          { signal: controller.signal },
        );
        primary = result.items.find((row) => row.isCurrent === true)?.fields;
        if (primary || result.items.length < 200) break;
        if (page === 10) throw new Error(d.readFailed);
      }
      if (!controller.signal.aborted) setState({ id, person, primary });
    };
    void read().catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ id, error });
    });
    return () => controller.abort();
  }, [api, id]);
  const current = state?.id === id ? state : undefined;
  return (
    <>
      {current?.error ? <Alert type="error" message={rejectionMessage(current.error)} /> : null}
      <h3>{d.primary}</h3>
      <Descriptions
        size="small"
        column={2}
        items={['departmentId', 'directManagerId', 'postId', 'levelId'].map((key) => ({
          key,
          label: d.labels[key],
          children: <NameOf path={refPaths[key]!} id={current?.primary?.[key]} />,
        }))}
      />
      <h3>{d.person}</h3>
      <Descriptions
        size="small"
        column={2}
        items={['name', 'code', 'email', 'gender', 'birthday'].map((key) => ({
          key,
          label: d.labels[key] ?? key,
          children: value(current?.person?.[key]),
        }))}
      />
    </>
  );
}
