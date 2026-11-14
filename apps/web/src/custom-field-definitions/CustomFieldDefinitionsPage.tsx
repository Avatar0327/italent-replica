import { CUSTOM_FIELD_OBJECT_TYPES, type CustomFieldObjectType } from '@italent/domain';
import { Button, Table, Select } from 'antd';
import { useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { createFormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { DefinitionForm } from './DefinitionForm.js';
import { actions, listPath, OBJECT, parseRows, type Definition } from './model.js';
import { m } from './messages.js';

// F-123：页面离开与重开仍持有结果未知的命令，内核按租户、身份隔离槽。
const store = createFormStore();
export function CustomFieldDefinitionsPage() {
  return (
    <FormCommands store={store}>
      <Definitions />
    </FormCommands>
  );
}
function Definitions() {
  const permission = usePermissions(OBJECT);
  const access = actions(permission.snapshot.objects[OBJECT]);
  const [objectType, setObjectType] = useState<CustomFieldObjectType>('employment');
  const [editing, setEditing] = useState<{ row?: Definition; mode?: 'inheritance' | 'options' }>();
  const read = useRead<unknown>(listPath(objectType));
  let rows: Definition[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) rows = parseRows(read.data);
  } catch (cause) {
    error = cause;
  }
  const managed = objectType === 'employment' || objectType === 'contract';
  const columns = columnsFor(managed, access, (row, mode) => setEditing({ row, mode }));
  return (
    <section>
      <header className="page-heading">
        <h1>{m.title}</h1>
        {access.create && !read.loading && !error && (
          <Button type="primary" onClick={() => setEditing({})}>
            {m.create}
          </Button>
        )}
        <Button onClick={read.refresh}>{m.refresh}</Button>
      </header>
      <Select
        aria-label={m.objectType}
        value={objectType}
        onChange={(key) => {
          setEditing(undefined);
          setObjectType(key as CustomFieldObjectType);
        }}
        options={CUSTOM_FIELD_OBJECT_TYPES.map((value) => ({ value, label: m.objects[value] }))}
      />
      {error ? (
        <PageState kind="error" error={error} retry={read.refresh} />
      ) : (
        <>
          {read.loading && <PageState kind="loading" />}
          {!read.loading && (
            <Table<Definition>
              rowKey="id"
              size="small"
              dataSource={rows}
              columns={columns}
              pagination={false}
              locale={{ emptyText: m.empty }}
            />
          )}
        </>
      )}
      {editing && (
        <DefinitionForm
          objectType={objectType}
          row={editing.row}
          mode={editing.mode}
          access={access}
          close={() => setEditing(undefined)}
          saved={read.refresh}
        />
      )}
    </section>
  );
}

function columnsFor(
  managed: boolean,
  access: ReturnType<typeof actions>,
  edit: (row: Definition, mode: 'inheritance' | 'options') => void,
) {
  return [
    { key: 'name', title: m.name, render: (_: unknown, row: Definition) => row.name ?? m.missing },
    {
      key: 'valueType',
      title: m.valueType,
      render: (_: unknown, row: Definition) => (row.valueType ? m.types[row.valueType] : m.missing),
    },
    {
      key: 'objectType',
      title: m.objectType,
      render: (_: unknown, row: Definition) => (row.objectType ? m.objects[row.objectType] : m.missing),
    },
    ...(managed
      ? [
          {
            key: 'inherit',
            title: m.inherit,
            render: (_: unknown, row: Definition) => {
              if (row.inherit === undefined) return m.missing;
              return row.inherit ? m.yes : m.no;
            },
          },
        ]
      : []),
    {
      key: 'actions',
      title: m.actions,
      render: (_: unknown, row: Definition) => (
        <>
          {managed && access.inherit && (
            <Button type="link" onClick={() => edit(row, 'inheritance')}>
              {m.edit}
            </Button>
          )}
          {row.valueType === 'select' && access.options && row.options && (
            <Button type="link" onClick={() => edit(row, 'options')}>
              {m.editOptions}
            </Button>
          )}
        </>
      ),
    },
  ];
}
