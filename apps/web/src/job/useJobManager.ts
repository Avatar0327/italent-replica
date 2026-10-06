import { useEffect, useState } from 'react';
import { JobApiError, request, type Job, type JobList } from './api.js';
import { sequenceSyncVisible, type Choice, type JobValue } from './JobForm.js';
import { text } from './messages.js';
export type Kind = 'posts' | 'positions';
interface Editor {
  original: Job | null;
  value: JobValue;
}
interface Write {
  path: string;
  method: string;
  body: unknown;
  revision: number;
  queued: boolean;
  key: string;
}

function useMutation(tenantId: string, saved: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState<Write | null>(null);
  const execute = async (command: Write) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(tenantId, command.path, {
        method: command.method,
        body: JSON.stringify(command.body),
        headers: { 'if-match': String(command.revision), 'idempotency-key': command.key },
      });
      setUnknown(null);
      setNotice(command.queued ? text.queued : text.saved);
      await saved();
    } catch (cause) {
      if (cause instanceof JobApiError) {
        setUnknown(null);
        setError(cause.message);
      } else {
        setUnknown(command);
        setError(text.uncertain);
      }
    } finally {
      setBusy(false);
    }
  };
  const mutate = (command: Omit<Write, 'key'>) => {
    if (!busy && !unknown) void execute({ ...command, key: crypto.randomUUID() });
  };
  return {
    busy,
    notice,
    error,
    setError,
    unknown,
    mutate,
    retry: () => {
      if (unknown && !busy) void execute(unknown);
    },
  };
}

function useChoices(tenantId: string, onError: (message: string) => void) {
  const [choices, setChoices] = useState({
    sequences: [] as Choice[],
    organizations: [] as Choice[],
    posts: [] as Choice[],
  });
  useEffect(() => {
    let active = true;
    const load = async () => {
      const values = await Promise.all(
        ['job/sequences', 'org/organizations', 'job/posts'].map((path) =>
          request<{ items: Choice[] }>(tenantId, `${path}?pageSize=200`),
        ),
      );
      if (active) setChoices({ sequences: values[0]!.items, organizations: values[1]!.items, posts: values[2]!.items });
    };
    void load().catch((cause: unknown) => {
      if (active) onError(String(cause));
    });
    return () => {
      active = false;
    };
  }, [tenantId, onError]);
  return choices;
}
export function useMessages(tenantId: string) {
  const [messages, setMessages] = useState<{ id: string; createdAt: string }[]>([]);
  useEffect(() => {
    let active = true;
    const poll = () => {
      void request<{ items: { id: string; createdAt: string }[] }>(tenantId, 'job/sequence-sync/messages')
        .then((result) => {
          if (active) setMessages(result.items);
        })
        .catch(() => {
          /* 下轮仍查询持久消息。 */
        });
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tenantId]);
  return messages;
}

export function useJobManager(tenantId: string) {
  const [kind, setKind] = useState<Kind>('posts');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<JobList>({ items: [], today: '' });
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const load = async () => {
    setList(await request<JobList>(tenantId, `job/${kind}?page=${page}`));
    setSelected([]);
  };
  const mutation = useMutation(tenantId, async () => {
    setEditor(null);
    await load();
  });
  const choices = useChoices(tenantId, mutation.setError);
  useEffect(() => {
    let active = true;
    void request<JobList>(tenantId, `job/${kind}?page=${page}`)
      .then((result) => {
        if (active) {
          setList(result);
          setSelected([]);
        }
      })
      .catch((cause: unknown) => {
        if (active) mutation.setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [tenantId, kind, page, mutation.setError]);
  const save = () => saveEditor(editor, kind, mutation.mutate);

  return {
    ...mutation,
    ...choices,
    kind,
    page,
    list,
    selected,
    setSelected,
    editor,
    setEditor,
    save,
    locked: mutation.busy || !!mutation.unknown,
    refresh: () => {
      void load().catch((cause: unknown) => mutation.setError(String(cause)));
    },
    changeKind: (kind: Kind) => {
      setKind(kind);
      setList({ items: [], today: '' });
      setSelected([]);
      setPage(1);
      setEditor(null);
    },
    changePage: (page: number) => {
      setPage(page);
      setEditor(null);
      setSelected([]);
    },
    edit: (original: Job | null) =>
      setEditor({
        original,
        value: { name: original?.name ?? '', sequenceId: original?.sequenceId ?? null, effectiveDate: list.today },
      }),
    sync: () =>
      mutation.mutate({
        path: `job/${kind}/sync-sequence`,
        method: 'POST',
        revision: 0,
        queued: true,
        body: {
          items: list.items.filter((item) => selected.includes(item.id)).map(({ id, revision }) => ({ id, revision })),
        },
      }),
  };
}
export type JobManagerState = ReturnType<typeof useJobManager>;

function saveEditor(editor: Editor | null, kind: Kind, mutate: (command: Omit<Write, 'key'>) => void) {
  if (!editor) return;
  const { original, value } = editor;
  const sync = sequenceSyncVisible(!!original, value.sequenceId, original?.sequenceId ?? null);
  const { effectiveDate, ...fields } = value;
  mutate({
    path: `job/${kind}${original ? `/${original.id}` : ''}`,
    method: original ? 'PATCH' : 'POST',
    body: {
      ...fields,
      ...(original
        ? { effectiveDate, ...(sync ? { syncSequenceToAssignments: true } : {}) }
        : { startDate: effectiveDate }),
    },
    revision: original?.revision ?? 0,
    queued: sync,
  });
}
