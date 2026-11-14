// 矩阵结构编辑（F-326 F2b，设计 §4.2 / §6）：列定义与数据行在本地草稿里改，保存时整体一次 PUT structure。
// 经 F-123 内核（useConflictCommand，动作 structure）：带本单 revision 与命令 ID；409 重读核对后显式重提，
// 结果未知锁定草稿与本单其他动作，只能按原命令重试（DEC-067）。
import { MATRIX_LIMITS } from '@italent/domain';
import { Alert, Button, ConfigProvider, Space, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type ApiClient, type Command } from '../../foundation/client.js';
import { PageState } from '../../foundation/PageState.js';
import { useApiClient } from '../../foundation/Session.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import type { Values } from '../../foundation/forms/store.js';
import { useLabels, type Labels } from './CellPicker.js';
import { mergeStructure, type Ambiguity, type Change, type Decided } from './structure-merge.js';
import { m } from './messages.js';
import { MATRICES, matrixPath, parseReceipt, type MatrixHead, type MatrixStatus } from './model.js';
import { StructureColumns } from './StructureColumns.js';
import { sm } from './structure-messages.js';
import {
  kindFull,
  kindOf,
  newRef,
  normalized,
  parseStructure,
  rowsFull,
  sameStructure,
  serverIssues,
  structureBody,
  structureIssues,
  structureSummary,
  type ColumnKind,
  type DraftColumn,
  type Issue,
  type Loaded,
  type Structure,
} from './structure-model.js';
import { addRow, removeRows, StructureRows } from './StructureRows.js';

type Receipt = { id: string; status: MatrixStatus };
type Saved = (receipt?: Receipt) => void;
type Update = (change: (structure: Structure) => Structure) => void;
type Writer = ReturnType<typeof useConflictCommand>;
type Send = (request: { command: Command<Values> }) => Promise<Receipt>;
const SHOWN_ISSUES = 20;

/** 读详情（头部 + 结构 + 名称）；头部 revision 前进（保存、编辑头部、启停）后重读。 */
function useDetail(head: MatrixHead, labels: Labels) {
  const api = useApiClient();
  const [detail, setDetail] = useState<{ loaded?: Loaded; error?: unknown }>({});
  const [attempt, setAttempt] = useState(0);
  const behind = !detail.loaded || detail.loaded.revision < head.revision;
  const adopt = useRef(labels.adopt);
  adopt.current = labels.adopt;
  useEffect(() => {
    if (!behind) return;
    const controller = new AbortController();
    void api.request<unknown>(matrixPath(head.id), { signal: controller.signal }).then(
      (raw) => {
        if (controller.signal.aborted) return;
        try {
          const loaded = parseStructure(raw);
          if (loaded.id !== head.id) throw new Error(m.invalidResponse);
          adopt.current(loaded.names);
          setDetail({ loaded });
        } catch (error) {
          setDetail((current) => ({ ...current, error }));
        }
      },
      (error: unknown) => !controller.signal.aborted && setDetail((current) => ({ ...current, error })),
    );
    return () => controller.abort();
  }, [api, head.id, behind, attempt]);
  return { ...detail, set: (loaded: Loaded) => setDetail({ loaded }), retry: () => setAttempt((n) => n + 1) };
}

/**
 * 草稿与它所基于的详情。读到新详情时：草稿没改就换成新结构；结构没变（只是头部改了版本）就保留草稿、跟进版本；
 * 别人改了结构而本地有草稿时保持旧基线，保存时由 409 走重读核对，不静默覆盖。
 */
function useDraft(loaded: Loaded, pending: { current?: Structure }) {
  const [state, setState] = useState<{ base: Loaded; draft: Structure }>();
  useEffect(() => {
    setState((current) => {
      // 首次进入时恢复本单未完成命令的草稿（如结果未知后离开再回来）
      if (!current) return { base: loaded, draft: pending.current ?? loaded.structure };
      if (current.base === loaded) return current;
      if (sameStructure(current.draft, current.base.structure)) return { base: loaded, draft: loaded.structure };
      if (sameStructure(current.base.structure, loaded.structure)) return { base: loaded, draft: current.draft };
      return current;
    });
  }, [loaded, pending]);
  return [state, setState] as const;
}

const addColumn = (kind: ColumnKind) => (structure: Structure) => {
  const column = {
    ref: newRef(),
    id: null,
    kind,
    dimension: kind === 'condition' ? ('department' as const) : null,
    includeChildren: false,
    name: '',
    allowMultiple: false,
  };
  // 条件列排在角色列之前：新条件列插在最后一个条件列之后，新角色列追加在末尾
  const at = kind === 'condition' ? structure.columns.filter((item) => item.kind === 'condition').length : undefined;
  const columns = [...structure.columns];
  columns.splice(at ?? columns.length, 0, column);
  return {
    columns,
    rows: structure.rows.map((row) => ({ ...row, cells: { ...row.cells, [column.ref]: [] } })),
  };
};

/**
 * 状态区：冲突核对逐处列出服务端的改动（structure-merge.ts，原值 / 最新值 / 我的输入与处理结果），没有改动也要确认；
 * 结果未知的原单读回只摆列名（类型）与行数，不把整份结构的 JSON 摆给用户。
 */
const project = (own: Writer['form']['state'], changes: Change[] = []) =>
  own && {
    ...own,
    differences: changes.map(({ field, before, latest, mine }) => ({ field, before, latest, mine })),
    latest: own.latest && { ...own.latest, values: { structure: structureSummary(own.latest.values.structure) } },
  };

/** 一次 PUT structure：回执按本命令 revision + 1 校验，回执即新详情（matrices.ts saveMatrixStructure）。 */
function saver(input: {
  api: ApiClient;
  head: MatrixHead;
  writer: Writer;
  labels: Labels;
  editable: boolean;
  done(outcome: Loaded, receipt: Receipt): void;
  rejected(issues: Issue[]): void;
}) {
  const { api, head, writer, labels } = input;
  let outcome: Loaded | undefined;
  const send: Send = async ({ command }) => {
    const raw = await api.request<unknown>(matrixPath(head.id, 'structure'), {
      method: 'PUT',
      command: { ...command, body: structureBody(command.body.structure as Structure, command.revision) },
    });
    const receipt = parseReceipt(raw, { id: head.id, revision: command.revision ?? 0 });
    outcome = parseStructure(raw);
    labels.adopt(outcome.names);
    return receipt;
  };
  const attempt = async (sent: Structure, run: (send: Send) => Promise<unknown>) => {
    let receipt: Receipt | undefined;
    try {
      await run(async (request) => (receipt = await send(request)));
    } catch (error) {
      // 结果未知保持锁定；冲突由状态区引导重读；明确拒绝时把字段明细标回行列
      if (writer.form.peek()?.status === 'rejected' && error instanceof ApiError)
        input.rejected(serverIssues(error.fieldErrors, sent));
      return;
    }
    input.done(outcome!, receipt!);
  };
  return {
    submit(draft: Structure) {
      const sent = normalized(draft);
      const editableFields = input.editable ? ['structure'] : [];
      return attempt(sent, (send) => writer.run({ values: { structure: sent }, editableFields, send }));
    },
    replay: (draft: Structure) => attempt(draft, (send) => writer.replay(send)),
  };
}

function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  const shown = issues.slice(0, SHOWN_ISSUES);
  return (
    <Alert
      className="matrix-issues"
      type="error"
      showIcon
      message={
        <ul>
          {shown.map((issue, index) => (
            <li key={index}>{issue.text}</li>
          ))}
          {issues.length > shown.length && <li>{sm.moreIssues(issues.length - shown.length)}</li>}
        </ul>
      }
    />
  );
}

/** 结构冲突（structure-merge.ts）：逐项采用最新版本或保留我的修改；处理完之前草稿锁定、不能保存。 */
function Ambiguities({ open, decide }: { open: Ambiguity[]; decide(key: string, take: boolean): void }) {
  if (!open.length) return null;
  const items = open.map(({ key, label }) => (
    <li key={key}>
      {label}
      <Button type="link" onClick={() => decide(key, true)}>
        {sm.takeLatest}
      </Button>
      <Button type="link" onClick={() => decide(key, false)}>
        {sm.keepMine}
      </Button>
    </li>
  ));
  return (
    <Alert
      className="matrix-ambiguities"
      type="warning"
      showIcon
      message={sm.ambiguousHint}
      description={<ul>{items}</ul>}
    />
  );
}

/** 工具栏与上限提示；显式 disabled 会盖过 ConfigProvider 的 componentDisabled，锁定时要并进来。 */
function Toolbar(props: { draft: Structure; locked: boolean; chosen: string[]; update: Update }) {
  const { draft, locked, chosen, update } = props;
  const conditionsFull = kindFull(draft, 'condition');
  const rolesFull = kindFull(draft, 'role');
  const full = rowsFull(draft);
  const limits = [
    conditionsFull && sm.conditionsFull(MATRIX_LIMITS.conditionColumns),
    rolesFull && sm.rolesFull(MATRIX_LIMITS.roleColumns),
    full && sm.rowsFull(MATRIX_LIMITS.rows),
  ].filter(Boolean) as string[];
  return (
    <>
      <Space wrap>
        <Button disabled={locked || conditionsFull} onClick={() => update(addColumn('condition'))}>
          {sm.addCondition}
        </Button>
        <Button disabled={locked || rolesFull} onClick={() => update(addColumn('role'))}>
          {sm.addRole}
        </Button>
        <Button disabled={locked || full} onClick={() => update(addRow)}>
          {sm.addRow}
        </Button>
        <Button danger disabled={locked || !chosen.length} onClick={() => update(removeRows(new Set(chosen)))}>
          {sm.batchRemove}
        </Button>
      </Space>
      {limits.map((limit) => (
        <Typography.Text key={limit} type="warning">
          {limit}
        </Typography.Text>
      ))}
    </>
  );
}

function Footer(props: { locked: boolean; dirty: boolean; ready: boolean; submit(): void; undo(): void }) {
  return (
    <Space>
      <Button type="primary" disabled={props.locked || !props.ready} onClick={props.submit}>
        {sm.save}
      </Button>
      <Button disabled={props.locked || !props.dirty} onClick={props.undo}>
        {sm.undo}
      </Button>
    </Space>
  );
}

export function StructureEditor({ head, editable, saved }: { head: MatrixHead; editable: boolean; saved: Saved }) {
  const labels = useLabels();
  const detail = useDetail(head, labels);
  if (detail.error && !detail.loaded)
    return (
      <section className="matrix-structure">
        <PageState kind="error" error={detail.error} retry={detail.retry} />
      </section>
    );
  if (!detail.loaded) return <section className="matrix-structure" />;
  return (
    <Editor head={head} editable={editable} saved={saved} loaded={detail.loaded} adopt={detail.set} labels={labels} />
  );
}

function useWriter(head: MatrixHead, loaded: Loaded, labels: Labels) {
  const api = useApiClient();
  const read = async () => {
    const latest = parseStructure(await api.request<unknown>(matrixPath(head.id)));
    labels.adopt(latest.names);
    return { id: latest.id, revision: latest.revision, values: { structure: normalized(latest.structure) } };
  };
  const pending = useRef<Structure>(undefined);
  const [state, setState] = useDraft(loaded, pending);
  // 命令版本跟随草稿的基线（不是最新读到的详情）：基线落后时保存得到 409，走重读核对
  const base = state?.base ?? loaded;
  const writer = useConflictCommand(
    MATRICES,
    { id: head.id, revision: base.revision, values: { structure: normalized(base.structure) } },
    read,
    { action: 'structure' },
  );
  const own = writer.form.state;
  pending.current = own && own.status !== 'done' ? (own.values.structure as Structure | undefined) : undefined;
  // 409 重读后：原基线、最新版本、我提交的草稿与结构冲突的处理（按这次重读到的最新版本记）四方合并；草稿换成
  // 合并结果，确认后据此重提。确认后内核基线换成最新版本，原基线取冲突差异里的 before（store.ts rereadState）
  const [picks, setPicks] = useState<{ latest?: unknown; decided: Decided }>({ decided: {} });
  const decided = picks.latest === own?.latest ? picks.decided : undefined;
  const merge = useMemo(() => {
    if (!own?.latest || !['conflict', 'idle'].includes(own.status)) return undefined;
    const show = (column: DraftColumn, ids: readonly string[]) =>
      ids.map((id) => labels.label(kindOf(column), id)).join('、') || sm.emptyCell;
    const value = (values: Values) => values.structure as Structure;
    const latest = value(own.latest.values);
    const before = own.differences?.find((change) => change.field === 'structure')?.before as Structure | undefined;
    return mergeStructure(before ?? latest, latest, value(own.values), show, decided);
    // labels 每次渲染都是新对象，名称缓存本身是模块级的；只在内核状态变化（重读完成、确认）或处理结构冲突时重算
  }, [own, decided]);
  useEffect(() => {
    if (merge) setState((value) => value && { ...value, draft: merge.structure });
  }, [merge, setState]);
  const decide = (key: string, take: boolean) =>
    setPicks({ latest: own?.latest, decided: { ...decided, [key]: take } });
  return { api, state, setState, writer, changes: merge?.changes, open: merge?.open ?? [], decide };
}

function Editor(props: {
  head: MatrixHead;
  editable: boolean;
  saved: Saved;
  loaded: Loaded;
  adopt(loaded: Loaded): void;
  labels: Labels;
}) {
  const { head, editable, labels } = props;
  const { api, state, setState, writer, changes, open, decide } = useWriter(head, props.loaded, labels);
  const [selected, setSelected] = useState<string[]>([]);
  const [server, setServer] = useState<Issue[]>([]);
  // 结构冲突处理完之前草稿锁定：每处理一项都按选择重算合并结果、换掉草稿
  const locked = writer.form.locked || writer.invalid || open.length > 0;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  if (!state) return <section className="matrix-structure" />;
  const own = writer.form.state;
  const draft = state.draft;
  const baseline = (writer.full.structure as Structure | undefined) ?? state.base.structure;
  const dirty = !sameStructure(draft, baseline);
  // 即时校验挡保存；服务端拒绝的明细只做标注，改草稿即清
  const local = structureIssues(draft, labels.has);
  const issues = [...local, ...server];
  const invalid = new Set(issues.flatMap((issue) => [issue.column, issue.row].filter(Boolean) as string[]));
  const update: Update = (change) => {
    if (lockedRef.current) return;
    setServer([]);
    // 被拒的命令不再挡着：改草稿后状态区的拒绝原因随之收起
    if (writer.form.state?.status === 'rejected') writer.form.clear();
    setState((value) => value && { ...value, draft: change(value.draft) });
  };
  const save = saver({
    ...{ api, head, writer, labels, editable },
    rejected: setServer,
    done(outcome, receipt) {
      setState({ base: outcome, draft: outcome.structure });
      props.adopt(outcome);
      setSelected([]);
      props.saved(receipt);
    },
  });
  const chosen = selected.filter((ref) => draft.rows.some((row) => row.ref === ref));
  return (
    <section className="matrix-structure">
      <Typography.Title level={5}>{sm.title}</Typography.Title>
      <CommandStatus
        submission={{ ...writer.form, state: project(own, changes) }}
        labels={{ structure: sm.structureLabel, ...Object.fromEntries((changes ?? []).map((c) => [c.field, c.label])) }}
      />
      {own?.status === 'unknown' && (
        <Button onClick={() => void save.replay(draft)} disabled={own.reading}>
          {sm.replay}
        </Button>
      )}
      <Ambiguities open={open} decide={decide} />
      <ConfigProvider componentDisabled={locked}>
        <Space direction="vertical" size="small" className="matrix-structure-body">
          {editable && <Toolbar draft={draft} locked={locked} chosen={chosen} update={update} />}
          <Typography.Text strong>{sm.columnsTitle}</Typography.Text>
          <StructureColumns structure={draft} invalid={invalid} readonly={!editable} update={update} />
          <Typography.Text strong>{sm.rowsTitle}</Typography.Text>
          <StructureRows
            {...{ structure: draft, invalid, readonly: !editable, locked, labels, update }}
            full={rowsFull(draft)}
            selected={chosen}
            select={setSelected}
          />
          <Issues issues={issues} />
          {editable && (
            <Footer
              locked={locked}
              ready={dirty && !local.length}
              submit={() => void save.submit(draft)}
              undo={() => update(() => baseline)}
              dirty={dirty}
            />
          )}
        </Space>
      </ConfigProvider>
    </section>
  );
}
