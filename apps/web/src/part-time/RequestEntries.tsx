import { Button, Drawer, Space } from 'antd';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { messages as kernel } from '../foundation/forms/messages.js';
import { PageState } from '../foundation/PageState.js';
import { apiRoot, type Row } from './model.js';
import { actionsFor, canCreate, isKind, requests, type RequestKind } from './request-model.js';
import { RequestForm } from './RequestForm.js';
import { useRequestAccess, type RequestSelection } from './request-commands.js';
import { useRead } from './useRead.js';
import { r } from './request-messages.js';
const Launch = createContext<((kind: RequestKind, target?: Row) => void) | undefined>(undefined);
export function RequestEntries({
  children,
  refresh,
  saved,
}: {
  children: ReactNode;
  refresh(): Promise<unknown>;
  saved(id: string): void;
}) {
  const [selection, select] = useState<RequestSelection>();
  return (
    <Launch.Provider value={(kind, target) => select({ kind, action: 'create', target })}>
      {children}
      {selection && <LoadForm selection={selection} close={() => select(undefined)} refresh={refresh} saved={saved} />}
    </Launch.Provider>
  );
}
export function NewRequestButton() {
  const open = useContext(Launch);
  const { permission } = useRequestAccess();
  return open && canCreate('add', permission) ? (
    <Button type="primary" onClick={() => open('add')}>
      {r.titles.add}
    </Button>
  ) : null;
}
export function DateRequestButtons({ row }: { row: Row }) {
  const open = useContext(Launch);
  const { permission } = useRequestAccess();
  return open ? (
    <Space wrap>
      {(['extend', 'end'] as const)
        .filter((kind) => canCreate(kind, permission))
        .map((kind) => (
          <Button type="link" key={kind} onClick={() => open(kind, row)}>
            {r.titles[kind]}
          </Button>
        ))}
    </Space>
  ) : null;
}
export function RequestActions({ row, refresh }: { row: Row; refresh(): Promise<unknown> }) {
  const { permission } = useRequestAccess();
  const [selection, select] = useState<RequestSelection>();
  return (
    <>
      <Space wrap>
        {actionsFor(row, permission).map((action) => (
          <Button
            key={action}
            onClick={() => {
              if (isKind(row.kind)) select({ kind: row.kind, action, row });
            }}
          >
            {r.actions[action]}
          </Button>
        ))}
      </Space>
      {selection && <LoadForm selection={selection} close={() => select(undefined)} refresh={refresh} />}
    </>
  );
}
function LoadForm(props: {
  selection: RequestSelection;
  close(): void;
  refresh(): Promise<unknown>;
  saved?(id: string): void;
}) {
  const { selection } = props;
  const id = selection.row?.id ?? selection.target?.id;
  const result = useRead<Row>(
    id ? `${selection.row ? requests : `${apiRoot}/part-times`}/${encodeURIComponent(id)}` : null,
  );
  const error =
    result.error ?? (result.data && id && result.data.id !== id ? new Error(kernel.invalidReceipt) : undefined);
  if (id && (!result.data || error))
    return (
      <Drawer open title={r.titles[selection.kind]} onClose={props.close}>
        <PageState kind={error ? 'error' : 'loading'} error={error} retry={result.refresh} />
      </Drawer>
    );
  const updated = { ...selection };
  if (selection.row) updated.row = result.data;
  else if (selection.target) updated.target = result.data;
  return <RequestForm {...props} selection={updated} />;
}
