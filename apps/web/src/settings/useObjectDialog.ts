import { Form, type FormInstance } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type Command } from '../foundation/client.js';
import { forAction } from '../foundation/forms/action.js';
import { createFormStore, type Values } from '../foundation/forms/store.js';
import { changedFields } from '../foundation/forms/values.js';
import { useCommandForm, useDraftRefill, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { useApiClient } from '../foundation/Session.js';
import {
  dialogError,
  dialogPath,
  profilePath,
  snapshotOf,
  writableKeys,
  type DialogMode,
  type DialogRead,
  type DialogSnapshot,
} from './object-dialog-model.js';
import { readDialog, saveDialog } from './object-dialog-api.js';
import { om } from './object-messages.js';
// 页面导航会卸载详情，未确认命令仍由内核按租户、身份及整份配置身份隔离保存。
const store = createFormStore();
export function useObjectDialog(
  id: string,
  objectCode: string,
  mode: DialogMode,
  editable: boolean,
  saved: () => void,
) {
  const api = useApiClient();
  const [form] = Form.useForm();
  const command: CommandForm = forAction(useCommandForm(profilePath(id), store), { objectCode, mode });
  const data = useDialogRead(id, objectCode, mode, form, command);
  const [notice, setNotice] = useState('');
  const keys = editable ? writableKeys(data.snapshot, mode) : [];
  useDraftRefill(command, keys, form);
  const reload = async () => {
    data.setError(undefined);
    await command.reread(async () => {
      try {
        const latest = await readDialog(api, data.path, id, objectCode, mode);
        data.replace(latest);
        return { id, revision: latest.revision, values: latest.values };
      } catch (cause) {
        if (data.alive.current) data.setError(dialogError(cause));
        throw cause;
      }
    });
  };
  const send = (request: Command<Values>) =>
    saveDialog(api, data.path, id, objectCode, mode, request, command.peek()?.baseline ?? {});
  const finish = (status?: string) => {
    if (status === 'done') {
      command.clear();
      if (data.alive.current) saved();
    }
  };
  const missing = [data.error, command.state?.error].some((cause) => cause instanceof ApiError && cause.status === 404);
  const locked = command.locked || !!command.blocked || !editable || data.loading || !!data.error || missing;
  const submit = async () => {
    if (locked || !data.snapshot) return;
    const values = form.getFieldsValue(true) as Values;
    const prior = command.state?.status === 'done' ? undefined : command.state;
    const baseline = { ...data.snapshot.values, ...prior?.baseline };
    const revision = prior?.revision ?? data.snapshot.revision;
    if (mode === 'fields' && !changedFields(values, baseline, keys).length) {
      setNotice(om.unchanged);
      return;
    }
    setNotice('');
    // 确定性拒绝后可继续翻页，重提须补齐新页基线，同时保留原 revision 和已核对的值。
    command.clear();
    const result = await command.submit({
      values,
      baseline,
      revision,
      editableFields: keys,
      businessId: id,
      patchOnly: mode === 'fields',
      send,
    });
    finish(result.status);
  };
  const replay = async () => {
    if (editable && !command.blocked) finish((await command.replay(send))?.status);
  };
  return { ...data, form, command: { ...command, reload }, notice, locked, submit, replay };
}
function useDialogSnapshot(form: FormInstance, command: CommandForm) {
  const [snapshot, setSnapshot] = useState<DialogSnapshot>();
  const current = useRef<DialogSnapshot>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const install = (next: DialogSnapshot, replace = false) => {
    if (!alive.current) return;
    const before = replace ? undefined : current.current;
    const merged = before
      ? {
          revision: before.revision,
          values: { ...next.values, ...before.values },
          rows: { ...next.rows, ...before.rows },
        }
      : next;
    const restored = command.state?.values ?? {};
    form.setFieldsValue(
      Object.fromEntries(
        Object.entries(next.values).filter(
          ([key]) => replace || (!Object.hasOwn(before?.values ?? {}, key) && !Object.hasOwn(restored, key)),
        ),
      ),
    );
    current.current = merged;
    setSnapshot(merged);
  };
  return { snapshot, install, alive };
}
function useDialogRead(id: string, objectCode: string, mode: DialogMode, form: FormInstance, command: CommandForm) {
  const api = useApiClient();
  const data = useDialogSnapshot(form, command);
  const [page, setPage] = useState({ current: 1, pageSize: 100 });
  const [code, setCode] = useState('');
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<DialogRead>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const path = dialogPath(id, objectCode, mode);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const params = new URLSearchParams({
      ...(query ? { code: query } : {}),
      limit: String(page.pageSize),
      offset: String((page.current - 1) * page.pageSize),
    });
    void api
      .request<DialogRead>(mode === 'fields' ? `${path}?${params}` : path, { signal: controller.signal })
      .then((raw) => {
        if (controller.signal.aborted) return;
        data.install(snapshotOf(raw, id, objectCode, mode));
        setResult(raw);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(dialogError(cause));
          setLoading(false);
        }
      });
    return () => controller.abort();
    // 查询变化只装入新字段的基线，已编辑字段和最初 revision 保留到冲突核对。
  }, [api, path, query, page.current, page.pageSize, version]);
  return {
    ...data,
    path,
    result,
    loading,
    error,
    setError,
    replace: (latest: DialogSnapshot) => {
      if (!data.alive.current) return;
      data.install(latest, true);
      if (mode !== 'fields') return;
      const rows = Object.values(latest.rows).filter((row) =>
        row.fieldCode.toLowerCase().includes(query.toLowerCase()),
      );
      const current = Math.min(page.current, Math.max(1, Math.ceil(rows.length / page.pageSize)));
      const offset = (current - 1) * page.pageSize;
      setPage({ ...page, current });
      setResult({
        profileId: id,
        objectCode,
        revision: latest.revision,
        items: rows.slice(offset, offset + page.pageSize),
        total: rows.length,
      });
    },
    page,
    setPage,
    code,
    setCode,
    apply: () => {
      setQuery(code.trim());
      setPage((p) => ({ ...p, current: 1 }));
    },
    retry: () => setVersion((v) => v + 1),
  };
}
