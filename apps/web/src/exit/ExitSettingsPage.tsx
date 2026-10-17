// R2-T03 FE2b：离职类型 / 离职原因 / 离职去向三个字典设置页（设计 §2.1、§3；DEC-577）。
import { Button, Table, Tabs, Tag } from 'antd';
import { useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import { useRead } from '../contracts/useRead.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { exitStore } from './commands.js';
import { DictionaryForm, RowCommands } from './DictionaryCommands.js';
import { m } from './messages.js';
import { EXIT_SETTINGS_OBJECT, KINDS, dictionaryPath, isKind, parseEntries, writeAccess } from './model.js';
import type { Entry, Kind } from './model.js';
import './exit.css';

export function ExitSettingsPage() {
  // 命令存储在模块级（commands.ts）：切换页签会按 pathname 重建页面，结果未知的命令不能随之丢失。
  return (
    <FormCommands store={exitStore}>
      <div className="exit-settings">
        <DecisionNote id="exit-settings" />
        <Routes>
          <Route index element={<Navigate to={KINDS[0]!} replace />} />
          <Route path=":kind" element={<DictionaryTabs />} />
          <Route path="*" element={<PageState kind="not-found" />} />
        </Routes>
      </div>
    </FormCommands>
  );
}

function DictionaryTabs() {
  const { kind } = useParams();
  const navigate = useNavigate();
  if (!isKind(kind)) return <PageState kind="not-found" />;
  return (
    <section className="exit-card">
      <Tabs
        activeKey={kind}
        // 相对当前页签切换，不写死入口路径（入口 id 由 pages.ts 登记）。
        onChange={(key) => void navigate(`../${key}`, { relative: 'path' })}
        items={KINDS.map((key) => ({ key, label: m.dictionaries[key] }))}
      />
      <Dictionary key={kind} kind={kind} />
    </section>
  );
}

function useEntries(kind: Kind) {
  const read = useRead<unknown>(dictionaryPath(kind));
  let rows: Entry[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) rows = parseEntries(read.data);
  } catch (cause) {
    error = cause;
  }
  return { rows, error, loading: read.loading, reload: read.refresh };
}

function Dictionary({ kind }: { kind: Kind }) {
  const permission = usePermissions(EXIT_SETTINGS_OBJECT);
  const access = writeAccess(permission.snapshot.objects[EXIT_SETTINGS_OBJECT]);
  const { rows, error, loading, reload } = useEntries(kind);
  const [editing, setEditing] = useState<{ row?: Entry }>();
  const label = m.dictionaries[kind];
  const editable = access.updateFields.some((field) => field !== 'enabled');
  const writable = access.updateFields.length > 0;
  return (
    <>
      <header className="exit-heading">
        <h1>{label}</h1>
        {access.create && !error && !loading && (
          <Button type="primary" onClick={() => setEditing({})}>
            {m.create}
          </Button>
        )}
      </header>
      {!!error && <PageState kind="error" error={error} retry={reload} />}
      {!error && loading && <PageState kind="loading" />}
      {!error && !loading && (
        <>
          <p className="exit-hint">{m.disableHint}</p>
          <Table<Entry>
            size="small"
            rowKey="id"
            dataSource={rows}
            pagination={false}
            locale={{ emptyText: m.empty }}
            columns={[
              { key: 'code', title: m.code, dataIndex: 'code', width: 220 },
              { key: 'name', title: m.name, dataIndex: 'name', width: 260 },
              {
                key: 'enabled',
                title: m.status,
                width: 120,
                render: (_: unknown, row: Entry) =>
                  row.enabled ? <Tag color="green">{m.enabled}</Tag> : <Tag>{m.disabled}</Tag>,
              },
              { key: 'displayOrder', title: m.displayOrder, dataIndex: 'displayOrder', width: 120 },
              ...(writable
                ? [
                    {
                      key: 'operation',
                      title: m.operation,
                      render: (_: unknown, row: Entry, index: number) => (
                        <RowCommands
                          kind={kind}
                          row={row}
                          rows={rows}
                          index={index}
                          access={access}
                          edit={editable ? () => setEditing({ row }) : undefined}
                          reload={reload}
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </>
      )}
      {editing && (
        <DictionaryForm
          kind={kind}
          row={editing.row}
          rows={rows}
          access={access}
          close={() => setEditing(undefined)}
          reload={reload}
        />
      )}
    </>
  );
}
