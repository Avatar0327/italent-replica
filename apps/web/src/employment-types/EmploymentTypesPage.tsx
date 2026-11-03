// F-323b（DEC-706）：设置 › 员工 › 人员类别。三视图（启用 / 停用 / 全部）+ 列表 + 详情抽屉，
// 原站口径见 docs/02_业务建模/17 §F-323；按钮按 /permission/me/objects 的按钮授权显隐，不按角色写死。
import { Button, Descriptions, Table, Tabs, Tag } from 'antd';
import { useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { DetailPage } from '../foundation/templates.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { typeStore } from './commands.js';
import { m } from './messages.js';
import { EMPLOYMENT_TYPE_OBJECT, VIEWS, listPath, parseRows, typeActions, type TypeRow, type View } from './model.js';
import { RowActions, TypeForm } from './TypeCommands.js';

const text = (value: unknown) => (value === undefined || value === null || value === '' ? m.missing : String(value));
const status = (row: TypeRow) =>
  row.enabled === undefined ? (
    m.missing
  ) : (
    <Tag color={row.enabled ? 'green' : undefined}>{row.enabled ? m.enabled : m.disabled}</Tag>
  );

function useRows(view: View) {
  const read = useRead<unknown>(listPath(view));
  let rows: TypeRow[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) rows = parseRows(read.data);
  } catch (cause) {
    error = cause;
  }
  return { rows, error, loading: read.loading, reload: read.refresh };
}

export function EmploymentTypesPage() {
  return (
    <FormCommands store={typeStore}>
      <TypeList />
    </FormCommands>
  );
}

function TypeList() {
  const permission = usePermissions(EMPLOYMENT_TYPE_OBJECT);
  const grant = permission.snapshot.objects[EMPLOYMENT_TYPE_OBJECT];
  const [view, setView] = useState<View>('enabled');
  const { rows, error, loading, reload } = useRows(view);
  const [selected, select] = useState<string>();
  const [editing, setEditing] = useState<{ row?: TypeRow }>();
  const actions = typeActions(grant);
  const row = rows.find((item) => item.id === selected);
  return (
    <section className="employment-types">
      <header className="page-heading">
        <h1>{m.title}</h1>
        {actions.create && !error && !loading && (
          <Button type="primary" onClick={() => setEditing({})}>
            {m.create}
          </Button>
        )}
      </header>
      <Tabs
        activeKey={view}
        onChange={(key) => setView(key as View)}
        items={VIEWS.map((key) => ({ key, label: m.views[key] }))}
      />
      {!!error && <PageState kind="error" error={error} retry={reload} />}
      {!error && loading && <PageState kind="loading" />}
      {!error && !loading && (
        <Table<TypeRow>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: m.empty }}
          columns={[
            {
              key: 'name',
              title: m.name,
              render: (_: unknown, item: TypeRow) => (
                <Button type="link" onClick={() => select(item.id)}>
                  {text(item.name)}
                </Button>
              ),
            },
            {
              key: 'displayOrder',
              title: m.displayOrder,
              render: (_: unknown, item: TypeRow) => text(item.displayOrder),
            },
            {
              key: 'effectiveDate',
              title: m.effectiveDate,
              render: (_: unknown, item: TypeRow) => text(item.effectiveDate),
            },
            { key: 'expiryDate', title: m.expiryDate, render: (_: unknown, item: TypeRow) => text(item.expiryDate) },
            { key: 'enabled', title: m.status, render: (_: unknown, item: TypeRow) => status(item) },
          ]}
        />
      )}
      {row && (
        <TypeDetail
          row={row}
          actions={typeActions(grant, row)}
          close={() => select(undefined)}
          edit={() => setEditing({ row })}
          saved={(removed) => {
            if (removed) select(undefined);
            reload();
          }}
        />
      )}
      {editing && (
        <TypeForm row={editing.row} rows={rows} actions={actions} close={() => setEditing(undefined)} saved={reload} />
      )}
    </section>
  );
}

/** 详情字段按原站：名称、顺序号、生效日期、状态（失效日期在列表与编辑表单里）。 */
function TypeDetail(props: {
  row: TypeRow;
  actions: ReturnType<typeof typeActions>;
  close(): void;
  edit(): void;
  saved(removed?: boolean): void;
}) {
  const { row, actions, close, edit, saved } = props;
  return (
    <DetailPage
      open
      onClose={close}
      title={text(row.name)}
      actions={<RowActions key={`${row.id}@${row.revision}`} row={row} actions={actions} edit={edit} saved={saved} />}
      sections={[
        {
          key: 'basic',
          title: m.basic,
          children: (
            <Descriptions
              column={2}
              size="small"
              items={[
                { key: 'name', label: m.name, children: text(row.name) },
                { key: 'displayOrder', label: m.displayOrder, children: text(row.displayOrder) },
                { key: 'effectiveDate', label: m.effectiveDate, children: text(row.effectiveDate) },
                { key: 'enabled', label: m.status, children: status(row) },
              ]}
            />
          ),
        },
      ]}
    />
  );
}
