import { Form, type FormInstance } from 'antd';
import { useEffect, useState } from 'react';
import { newCommand } from '../foundation/client.js';
import { useApiClient } from '../foundation/Session.js';
import type { Values } from '../foundation/forms/values.js';
import { apiRoot } from './model.js';
import { bodyFor, requestError } from './request-model.js';
/** 预览不写业务，只带当前可写字段；取消过时请求，不能覆盖用户已改的经理/序列。 */
export function useRequestPreview(form: FormInstance, enabled: boolean, editable: string[]) {
  const api = useApiClient();
  const employee = Form.useWatch('employeeId', form);
  const department = Form.useWatch('departmentId', form);
  const start = Form.useWatch('effectiveDate', form);
  const type = Form.useWatch('serviceType', form);
  const post = Form.useWatch('postId', form);
  const [error, setError] = useState<unknown>();
  const key = editable.join(',');
  useEffect(() => {
    const abort = new AbortController();
    setError(undefined);
    if (!enabled || !employee || !department || !start || !type) return;
    const values = Object.fromEntries(key.split(',').map((name) => [name, form.getFieldValue(name)]));
    for (const name of ['directManagerId', 'sequenceId']) if (!form.isFieldTouched(name)) delete values[name];
    const {
      requestType: _kind,
      employeeId: _id,
      submit: _submit,
      requestRemark: _remark,
      ...body
    } = bodyFor('add', 'create', values, false);
    void api
      .request<{ fields?: Values }>(`${apiRoot}/employees/${encodeURIComponent(employee)}/part-times/preview`, {
        method: 'POST',
        command: newCommand(body),
        signal: abort.signal,
      })
      .then((preview) => {
        if (abort.signal.aborted) return;
        for (const name of ['directManagerId', 'sequenceId'])
          if (key.split(',').includes(name) && !form.isFieldTouched(name))
            form.setFieldValue(name, preview.fields?.[name] ?? null);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(requestError(cause));
      });
    return () => abort.abort();
  }, [api, form, enabled, employee, department, start, type, post, key]);
  return error;
}
