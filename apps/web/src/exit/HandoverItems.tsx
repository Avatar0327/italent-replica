// B64 交接事项设置（FE-R2c2b）：按事项类别分组列出，新增 / 编辑 / 删除。字段与校验取后端 exit-handover-items.ts；
// 整份保存（严格 DTO），所以只有全部字段可看可改、且持有其他设置权时才开放写入。列序 / 列宽未验证。
import { HANDOVER_TODO_TYPES } from '@italent/domain';
import { Button, Input, InputNumber, Select, Table } from 'antd';
import { useState } from 'react';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { projectFields } from '../foundation/forms/values.js';
import {
  RecordForm,
  configField,
  configOperation,
  fieldColumn,
  label,
  options,
  rowReader,
  useParsed,
} from './settings-commands.js';
import { s } from './settings-messages.js';
import {
  FIELD_MAX,
  HANDOVER_ITEMS_PATH,
  HANDOVER_ITEM_FIELDS,
  configAccess,
  groupByCategory,
  itemBody,
  parseRowReceipt,
  parseRows,
  rowPath,
  type Row,
} from './settings-model.js';
import { EXIT_SETTINGS_OBJECT } from './model.js';

const MAX = FIELD_MAX.item;

const LABELS: Record<string, string> = s.item;
const field = configField(LABELS);
const values = (row: Row) => projectFields(row, HANDOVER_ITEM_FIELDS);
const parse = (raw: unknown) => parseRows(raw, 'item');
const todoLabel = label(HANDOVER_TODO_TYPES);

export function HandoverItems() {
  const api = useApiClient();
  const permission = usePermissions(EXIT_SETTINGS_OBJECT);
  const access = configAccess(
    permission.snapshot.objects[EXIT_SETTINGS_OBJECT],
    permission.menus,
    HANDOVER_ITEM_FIELDS,
  );
  const { data: rows, error, loading, reload } = useParsed(HANDOVER_ITEMS_PATH, parse);
  const [editing, setEditing] = useState<{ row?: Row }>();
  const operation = { api, collection: HANDOVER_ITEMS_PATH, parse, labels: LABELS, reload };
  const columns = [
    fieldColumn('sequenceNo', s.item.sequenceNo, undefined, 80),
    fieldColumn('todoType', s.item.todoType, todoLabel, 120),
    fieldColumn('title', s.item.title),
    fieldColumn('formRef', s.item.formRef, undefined, 180),
    fieldColumn('remark', s.item.remark, undefined, 220),
    ...(access.update ? [configOperation({ ...operation, edit: (row) => setEditing({ row }) })] : []),
  ];
  return (
    <section aria-label={s.tabs['handover-items']}>
      <header className="exit-heading">
        <h1>{s.tabs['handover-items']}</h1>
        {access.create && rows && (
          <Button type="primary" onClick={() => setEditing({})}>
            {s.create}
          </Button>
        )}
      </header>
      <p className="exit-hint">{access.create || access.update ? s.item.hint : s.readonlyHint}</p>
      {!!error && <PageState kind="error" error={error} retry={reload} />}
      {loading && <PageState kind="loading" />}
      {rows && !rows.length && <PageState kind="empty" />}
      {rows &&
        groupByCategory(rows).map((group) => (
          <section key={group.category} className="exit-settings-group" aria-label={group.category}>
            <h2>{group.category}</h2>
            <Table<Row> size="small" rowKey="id" dataSource={group.items} pagination={false} columns={columns} />
          </section>
        ))}
      {editing && rows && (
        <ItemForm row={editing.row} rows={rows} close={() => setEditing(undefined)} reload={reload} />
      )}
    </section>
  );
}

function ItemForm(props: { row?: Row; rows: Row[]; close(): void; reload(): void }) {
  const api = useApiClient();
  const { row } = props;
  const required = { required: true, whitespace: true, message: s.required };
  const next = Math.max(0, ...props.rows.map((item) => Number(item.sequenceNo) || 0)) + 1;
  return (
    <RecordForm
      resource={HANDOVER_ITEMS_PATH}
      title={`${row ? s.edit : s.create}${s.tabs['handover-items']}`}
      row={row}
      values={row ? values(row) : { todoType: 'work_handover', sequenceNo: Math.min(next, MAX.sequenceNo) }}
      read={row && rowReader(api, HANDOVER_ITEMS_PATH, parse, row.id, values)}
      fields={[
        field('category', <Input maxLength={MAX.category} />, [required]),
        field('sequenceNo', <InputNumber min={1} max={MAX.sequenceNo} precision={0} />, [
          { required: true, type: 'integer', min: 1, max: MAX.sequenceNo, message: s.item.sequenceRange },
        ]),
        field('todoType', <Select aria-label={s.item.todoType} options={options(HANDOVER_TODO_TYPES)} />, [
          { required: true, message: s.required },
        ]),
        field('title', <Input maxLength={MAX.title} />, [required]),
        field('formRef', <Input maxLength={MAX.formRef} />),
        field('remark', <Input.TextArea maxLength={MAX.remark} rows={3} />),
      ]}
      send={async (full, edited, command) => {
        const path = row ? rowPath(HANDOVER_ITEMS_PATH, row.id) : HANDOVER_ITEMS_PATH;
        const body = itemBody(full, edited);
        const raw = await api.request<unknown>(path, { method: row ? 'PUT' : 'POST', command: { ...command, body } });
        return parseRowReceipt(raw, 'item', { id: row?.id, revision: command.revision ?? 0 });
      }}
      close={props.close}
      reload={props.reload}
    />
  );
}
