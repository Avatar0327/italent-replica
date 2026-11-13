import { Form, type FormInstance } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { PAGE_CATALOG } from '@italent/domain';
import { type ApiClient, type Command } from '../foundation/client.js';
import { forAction } from '../foundation/forms/action.js';
import { type Values } from '../foundation/forms/store.js';
import { useCommandForm, useDraftRefill, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { useApiClient } from '../foundation/Session.js';
import { dialogError, profilePath, type ProfileDetail } from './object-dialog-model.js';
import { pageBody, pageValues } from './page-permission-model.js';
import { profileCommandStore } from './profile-command-store.js';
import { pm } from './page-messages.js';

export function usePagePermissionDialog(
  profile: ProfileDetail,
  objectCode: string,
  remove: string | undefined,
  editable: boolean,
  saved: () => void,
) {
  const api = useApiClient();
  const [form] = Form.useForm();
  const command: CommandForm = forAction(useCommandForm(profilePath(profile.id), profileCommandStore), {
    objectCode,
    mode: 'pages',
  });
  const data = usePageRead(api, profile, objectCode, form, command);
  const pages = PAGE_CATALOG.filter((p) => p.carrierObject === objectCode);
  const allowed = editable && pages.every((p) => data.current.apps.includes(p.appCode));
  const keys = allowed ? [...pages.map((p) => p.pageCode), 'catalogDigest'] : [];
  useDraftRefill(command, keys, form);
  const { initial, catalogError } = initialValues(data.current, objectCode);
  const removal = remove ? { [remove]: false } : {};
  const send = pageSender(api, profile.id, objectCode);
  const finish = (status?: string) => {
    if (status !== 'done') return;
    command.clear();
    if (data.alive.current) saved();
  };
  const locked = command.locked || !!command.blocked || !allowed || data.loading || !!data.error || !!catalogError;
  const submit = async () => {
    if (locked) return;
    // 新增与删除共用身份恢复槽：恢复的新增草稿可能把目标页回填为 true，删除提交须以删除目标为准。
    // 结果未知的原请求重放走 replay，不经此处，保持原 body。
    const values = { ...(form.getFieldsValue(true) as Values), ...removal };
    const request = { values, baseline: initial, revision: data.current.revision, businessId: profile.id };
    finish((await command.submit({ ...request, editableFields: keys, send })).status);
  };
  const replay = async () => {
    const state = command.peek();
    if (allowed && !command.blocked && state?.latest && !state.readError && !state.reading)
      finish((await command.replay(send))?.status);
  };
  return {
    form,
    command: { ...command, reload: data.reload },
    current: data.current,
    locked,
    loading: data.loading,
    error: data.error ?? catalogError,
    initial: { ...initial, ...removal },
    submit,
    replay,
    reload: data.reload,
  };
}

function initialValues(profile: ProfileDetail, objectCode: string): { initial: Values; catalogError?: unknown } {
  try {
    return { initial: pageValues(profile, objectCode) };
  } catch (cause) {
    return { initial: {}, catalogError: cause };
  }
}

const isDetail = (latest: ProfileDetail, id: string) =>
  latest.id === id &&
  Number.isSafeInteger(latest.revision) &&
  latest.revision >= 0 &&
  Array.isArray(latest.objects) &&
  Array.isArray(latest.apps);

function usePageRead(
  api: ApiClient,
  profile: ProfileDetail,
  objectCode: string,
  form: FormInstance,
  command: CommandForm,
) {
  const [current, setCurrent] = useState(profile);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = async () => {
    const latest = await api.request<ProfileDetail>(profilePath(profile.id));
    if (!isDetail(latest, profile.id)) throw new Error(pm.invalid);
    const values = pageValues(latest, objectCode);
    if (alive.current) {
      setCurrent(latest);
      form.setFieldsValue(values);
    }
    return { id: latest.id, revision: latest.revision, values };
  };
  const reload = async () => {
    setLoading(true);
    setError(undefined);
    try {
      if (['conflict', 'unknown'].includes(command.status)) await command.reread(read);
      else await read();
    } catch (cause) {
      if (alive.current) setError(cause);
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  return { current, error, loading, reload, alive };
}

function pageSender(api: ApiClient, id: string, objectCode: string) {
  return async (request: Command<Values>) => {
    let receipt: ProfileDetail;
    try {
      receipt = await api.request<ProfileDetail>(`${profilePath(id)}/objects/${encodeURIComponent(objectCode)}`, {
        method: 'PUT',
        command: { ...request, body: pageBody(request.body, objectCode) },
      });
    } catch (cause) {
      throw dialogError(cause);
    }
    // 回执须是同一身份的下一版本且含载体行，否则按结果未知处理，不当成功关闭。
    if (
      receipt.id !== id ||
      receipt.revision !== request.revision! + 1 ||
      !Array.isArray(receipt.objects) ||
      !receipt.objects.some((o) => o.objectCode === objectCode)
    )
      throw new Error(pm.invalid);
    return { id };
  };
}
