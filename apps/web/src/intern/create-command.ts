import { useRef, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import type { Values } from '../foundation/forms/values.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { apiRoot, interns, listPath } from './model.js';
import { acceptCreateReceipt, createBody, type CreateReceipt, type Selected } from './create-model.js';
import { readCandidate } from './RehireCheck.js';
import { retainProfileClears } from './create-profile.js';
import { c } from './create-messages.js';

/** 固定页面恢复槽：新增、选择候选、换视图均不换槽，未确认时不能另发命令。 */
export function useCreateCommand() {
  const form = useCommandForm(`${interns}/new`);
  const api = useApiClient();
  const post = useDirectApi();
  const running = useRef(false);
  const result = useResultQuery(form);
  const reload = () =>
    form.reread(async (id) => {
      const state = form.peek();
      if (!id || !state || state.context?.kind !== 'rehire') throw new Error(c.matchFailed);
      const latest = await readCandidate(api, state.values, id);
      // 这些字段是本次新任职的草稿，没有可从旧离职任职继承的基线；只刷新候选员工的版本。
      return { id, revision: latest.revision, values: retainProfileClears(state.values, state.baseline) };
    });
  return {
    form: {
      ...form,
      reload: form.status === 'conflict' && form.state?.context?.kind === 'rehire' ? reload : undefined,
    },
    ...result,
    async submit(values: Values, editableFields: string[], selected: Selected | undefined, pending: boolean) {
      if (running.current || form.locked) return;
      running.current = true;
      let receipt: CreateReceipt | undefined;
      try {
        const outcome = await form.submit({
          values,
          editableFields,
          baseline: {},
          revision: selected?.revision ?? 0,
          businessId: selected?.candidate.employeeId,
          context: { kind: selected ? 'rehire' : 'hire', employeeId: selected?.candidate.employeeId },
          send: async (command) => {
            const body = createBody(command.body, selected, pending);
            const raw = await post(interns, 'POST', { ...command, body });
            try {
              receipt = acceptCreateReceipt(raw, body, command.revision!);
              const saved = await api.request<{ id: string; revision: number }>(
                `${apiRoot}/businesses/${encodeURIComponent(receipt.businessId)}`,
              );
              if (
                saved.id !== receipt.businessId ||
                !Number.isSafeInteger(saved.revision) ||
                saved.revision < receipt.revision
              )
                throw new Error(c.invalidReceipt);
              // 写后读取失败也保持未知锁；只按回执 view 读目标列表，不按前端时钟猜去向。
              const path =
                receipt.view === 'interning'
                  ? listPath('interning', 1)
                  : `${apiRoot}/pending-entries?view=all&page=1&pageSize=30`;
              const list = await api.request<{ items: unknown[] }>(path);
              if (!Array.isArray(list.items)) throw new Error(c.invalidReceipt);
              return { id: receipt.employeeId };
            } catch (cause) {
              // POST 已返回成功；后续 GET 的 4xx 不能误归为写入被拒并解锁重提。
              throw new Error(c.invalidReceipt, { cause });
            }
          },
        });
        if (outcome.status !== 'done') throw outcome.error;
        form.clear();
        return receipt;
      } finally {
        running.current = false;
      }
    },
  };
}

function useResultQuery(form: ReturnType<typeof useCommandForm>) {
  const api = useApiClient();
  const [query, setQuery] = useState<{ busy?: boolean; message?: string; error?: unknown }>({});
  return {
    query,
    async queryResult() {
      const id = form.peek()?.command?.id;
      if (!id || query.busy) return;
      setQuery({ busy: true });
      try {
        const result = await api.request<{
          commandId: string;
          status: string;
          businessId?: string;
          businessType?: string;
          revision?: number;
        }>(`/api/tenant/commands/${encodeURIComponent(id)}/result`);
        if (result.commandId !== id || !['succeeded', 'failed'].includes(result.status))
          throw new Error(c.invalidReceipt);
        if (result.status === 'succeeded') {
          if (
            !result.businessId ||
            result.businessType !== form.peek()?.context?.kind ||
            !Number.isSafeInteger(result.revision) ||
            result.revision! < 0
          )
            throw new Error(c.invalidReceipt);
          const business = await api.request<{ id: string; revision: number }>(
            `${apiRoot}/businesses/${encodeURIComponent(result.businessId)}`,
          );
          if (
            business.id !== result.businessId ||
            !Number.isSafeInteger(business.revision) ||
            business.revision < result.revision!
          )
            throw new Error(c.invalidReceipt);
          setQuery({ message: c.querySuccess });
        } else setQuery({ message: c.queryRejected });
      } catch (error) {
        setQuery({ error });
      }
    },
  };
}
