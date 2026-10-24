import { Alert, Button, Descriptions, Modal, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { NameOf, refPaths } from '../contracts/references.js';
import { newCommand, rejectionMessage } from '../foundation/client.js';
import { useApiClient } from '../foundation/Session.js';
import type { Values } from '../foundation/forms/values.js';
import { apiRoot } from './model.js';
import { c } from './create-messages.js';
import { docKey, type Candidate, type Selected } from './create-model.js';

type Api = ReturnType<typeof useApiClient>;
/** 匹配请求与响应校验的单一入口；查询不写业务，不复用保存命令。 */
export async function matchDocument(api: Api, values: Values): Promise<Candidate | undefined> {
  const [idType, idNumber] = JSON.parse(docKey(values)) as string[];
  const r = await api.request<{ matched?: unknown; candidate?: Candidate }>(`${apiRoot}/rehire-matches`, {
    method: 'POST',
    command: newCommand({ idType, idNumber }),
  });
  if (r.matched === false) return undefined;
  if (r.matched !== true || !r.candidate || typeof r.candidate.employeeId !== 'string' || !r.candidate.employeeId)
    throw new Error(c.matchFailed);
  return r.candidate;
}
export async function readCandidate(api: Api, values: Values, employeeId: string) {
  const read = async () => {
    const r = await api.request<{ id: string; revision: number }>(
      `${apiRoot}/employees/${encodeURIComponent(employeeId)}`,
    );
    if (r.id !== employeeId || !Number.isSafeInteger(r.revision) || r.revision < 0) throw new Error(c.matchFailed);
    return r.revision;
  };
  const before = await read();
  const candidate = await matchDocument(api, values);
  const after = await read();
  if (!candidate || candidate.employeeId !== employeeId || candidate.endKind !== 'leave' || before !== after)
    throw new Error(c.candidateChanged);
  return { candidate, revision: after };
}
export function useRehireCheck() {
  const api = useApiClient();
  const epoch = useRef(0);
  const [state, set] = useState<{
    key?: string;
    values?: Values;
    candidate?: Candidate;
    selected?: Selected;
    prompt?: boolean;
    busy?: boolean;
    error?: unknown;
    checked?: boolean;
  }>({});
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const reset = () => {
    epoch.current++;
    set({});
  };
  return {
    ...state,
    reset,
    async check(values: Values) {
      const current = ++epoch.current;
      set({ values, key: docKey(values), busy: true });
      try {
        const candidate = await matchDocument(api, values);
        if (current === epoch.current)
          set({ values, key: docKey(values), candidate, checked: true, prompt: !!candidate });
      } catch (error) {
        if (current === epoch.current) set({ error });
      }
    },
    async choose(rehire: boolean) {
      if (!rehire) {
        epoch.current++;
        set((s) => ({ ...s, prompt: false, busy: false, selected: undefined }));
        return;
      }
      if (!state.candidate || state.candidate.endKind !== 'leave' || !state.values) return;
      const current = ++epoch.current;
      set((s) => ({ ...s, busy: true, error: undefined }));
      try {
        const selected = await readCandidate(api, state.values, state.candidate.employeeId);
        if (current === epoch.current) set((s) => ({ ...s, selected, prompt: false, busy: false }));
      } catch (error) {
        if (current === epoch.current) set((s) => ({ ...s, error, busy: false }));
      }
    },
  };
}
export function RehirePrompt({ match }: { match: ReturnType<typeof useRehireCheck> }) {
  const person = match.candidate;
  if (!match.prompt || !person) return null;
  const eligible = person.endKind === 'leave';
  const endLabels = { leave: c.leave, retirement: c.retirement };
  return (
    <Modal
      open
      title={c.matchTitle}
      onCancel={() => void match.choose(false)}
      maskClosable={false}
      closable={!match.busy}
      keyboard={!match.busy}
      footer={
        <Space>
          <Button disabled={match.busy} onClick={() => void match.choose(false)}>
            {c.no}
          </Button>
          <Button
            type="primary"
            disabled={!eligible || match.busy}
            loading={match.busy}
            onClick={() => void match.choose(true)}
          >
            {c.rehire}
          </Button>
        </Space>
      }
    >
      <Descriptions
        column={1}
        items={[
          { key: 'name', label: c.oldName, children: person.name ?? '--' },
          { key: 'code', label: c.oldCode, children: person.code ?? '--' },
          {
            key: 'end',
            label: c.endKind,
            children: person.endKind ? (endLabels[person.endKind] ?? '--') : '--',
          },
          { key: 'date', label: c.lastWorkDate, children: person.lastWorkDate ?? '--' },
          {
            key: 'dept',
            label: c.oldDepartment,
            children: <NameOf path={refPaths.departmentId} id={person.departmentId} />,
          },
        ]}
      />
      {!eligible && <Alert type="info" message={person.endKind === 'retirement' ? c.retire : c.hiddenEnd} />}
      {!!match.error && <Alert type="error" message={rejectionMessage(match.error)} />}
    </Modal>
  );
}
