import { Alert, Button, Drawer, Pagination, Space, Switch, Table } from 'antd';
import { useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import type { PageResult } from '../foundation/client.js';
import { ui } from '../foundation/messages.js';
import { configAccess, configObjects, contractApi, value, type Config, type Row } from './model.js';
import { useRead } from './useRead.js';
import { m } from './messages.js';
import { Fields } from './parts.js';
import { ConfigForm, RowCommand } from './ConfigForms.js';
import { RefLabel, RefLabels, refPaths } from './references.js';

const pageSize = 15;
export function ContractConfig({ kind }: { kind: Config }) {
  const permission = usePermissions(configObjects[kind]);
  const allowed = permission.snapshot.objects[configObjects[kind]]?.viewableFields ?? [];
  const [page, setPage] = useState(1);
  const [rule, setRule] = useState<Row>();
  const [editing, setEditing] = useState<{ row?: Row }>();
  const path = kind === 'settings' ? contractApi.settings : `${contractApi[kind]}?page=${page}&pageSize=${pageSize}`;
  const result = useRead<Row & Partial<PageResult<Row>>>(path);
  const settingPermission = usePermissions(configObjects.settings);
  const settings = useRead<Row>(
    kind === 'rules' && settingPermission.snapshot.objects[configObjects.settings] ? contractApi.settings : null,
  );
  const rows = result.data?.items ?? [];
  const access = configAccess(permission.snapshot.objects[configObjects[kind]]);
  const canCreate = kind !== 'settings' && access.create;
  const canEdit = access.update;
  return (
    <section className="contract-card">
      <header className="contract-heading">
        <h1>{m[kind]}</h1>
        <Space>
          {canCreate && (
            <Button type="primary" onClick={() => setEditing({})}>
              {m.create}
            </Button>
          )}
          {kind === 'settings' && canEdit && result.data && (
            <Button type="primary" onClick={() => setEditing({ row: result.data })}>
              {m.edit}
            </Button>
          )}
        </Space>
      </header>
      {!!result.error && <PageState kind="error" error={result.error} retry={result.refresh} />}
      {!result.error && result.loading && <PageState kind="loading" />}
      {!result.error && !result.loading && kind === 'settings' && (
        <SettingsFields row={result.data ?? {}} allowed={allowed} />
      )}
      {!result.error && !result.loading && kind !== 'settings' && (
        <>
          {kind === 'rules' && (
            <RenewalSwitch settings={settings} visible={settingPermission.field('autoRenew').visible} />
          )}
          {kind === 'types' && <p>{m.displayOrderGap}</p>}
          <ConfigTable
            kind={kind}
            rows={rows}
            allowed={allowed}
            setRule={setRule}
            edit={canEdit ? (row) => setEditing({ row }) : undefined}
            removable={kind === 'rules' && canEdit}
            toggle={kind === 'types' && canEdit && canToggle(permission.field)}
            reload={result.refresh}
          />
          <ConfigPagination kind={kind} page={page} rows={rows.length} total={result.data?.total} setPage={setPage} />
        </>
      )}
      <RuleDrawer rule={rule} allowed={allowed} close={() => setRule(undefined)} />
      {editing && (
        <ConfigForm
          kind={kind}
          row={editing.row}
          tenantId={kind === 'settings' ? String(result.data?.tenantId ?? '') : undefined}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            result.refresh();
          }}
        />
      )}
    </section>
  );
}
/** 规则列表有 total；类型列表接口不返回 total（后端缺口），按“本页满 15 条即可能有下一页”翻页。 */
function ConfigPagination({
  kind,
  page,
  rows,
  total,
  setPage,
}: {
  kind: Config;
  page: number;
  rows: number;
  total?: number;
  setPage(page: number): void;
}) {
  const known = kind === 'rules' && typeof total === 'number';
  const estimate = (page - 1) * pageSize + rows + (rows === pageSize ? 1 : 0);
  return (
    <div className="contract-toolbar contract-pagination">
      {known && <span>{m.total(total)}</span>}
      <Pagination
        current={page}
        pageSize={pageSize}
        total={known ? total : estimate}
        showSizeChanger={false}
        showTotal={() => `${pageSize}${ui.perPage}`}
        onChange={setPage}
      />
    </div>
  );
}
function SettingsFields({ row, allowed }: { row: Row; allowed: readonly string[] }) {
  const typeKeys = ['postExitTypeIds', 'indefiniteTypeIds', 'renewalTypeIds'];
  const keys = [
    'autoRenew',
    'autoTerminate',
    'postExitTypeIds',
    'indefiniteTypeIds',
    'accumulateRehire',
    'renewalTypeIds',
    'autoNumber',
    'uniqueFields',
  ].filter((key) => allowed.includes(key));
  return (
    <>
      <Alert type="info" message={m.settingHint} />
      <dl className="contract-settings">
        {keys.map((key) => (
          <div key={key}>
            <dt>{m.fields[key]}</dt>
            <dd>
              {typeKeys.includes(key) ? (
                <RefLabels path={refPaths.typeId} ids={row[key]} />
              ) : key === 'uniqueFields' && Array.isArray(row[key]) ? (
                (row[key] as string[]).map((field) => m.fields[field] ?? field).join('、') || '--'
              ) : (
                value(row[key], key)
              )}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}
function RenewalSwitch({ settings, visible }: { settings: ReturnType<typeof useRead<Row>>; visible: boolean }) {
  return (
    <>
      <h2>{m.fields.autoRenew}</h2>
      <p>{m.renewalHint}</p>
      {settings.error ? (
        <PageState kind="error" error={settings.error} retry={settings.refresh} />
      ) : (
        visible &&
        typeof settings.data?.autoRenew === 'boolean' && (
          <Switch aria-label={m.fields.autoRenew} disabled checked={settings.data.autoRenew} />
        )
      )}
    </>
  );
}
function ConfigTable({
  kind,
  rows,
  allowed,
  setRule,
  edit,
  removable,
  toggle,
  reload,
}: {
  kind: Config;
  rows: Row[];
  allowed: readonly string[];
  setRule(row: Row): void;
  edit?: (row: Row) => void;
  removable: boolean;
  toggle: boolean;
  reload(): void;
}) {
  const keys =
    kind === 'types'
      ? ['code', 'name', 'enabled', 'displayOrder']
      : ['priority', 'name', 'enabled', 'orgIds', 'personIds', 'details'];
  return (
    <Table<Row>
      size="small"
      rowKey={(row) => String(row.id ?? row.code)}
      dataSource={rows}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: m.empty }}
      columns={[
        ...keys
          .filter((key) => allowed.includes(key))
          .map((key) => ({
            key,
            title:
              ({ name: kind === 'types' ? m.typeName : m.ruleName, code: m.typeCode } as Record<string, string>)[key] ??
              m.fields[key],
            width: kind === 'types' ? 254 : (({ priority: 132 } as Record<string, number>)[key] ?? 222),
            render: (_: unknown, row: Row) => configValue(row, key),
          })),
        {
          key: 'open',
          title: m.operation,
          width: 200,
          render: (_: unknown, row: Row) => (
            <Space size={4}>
              {kind === 'rules' && (
                <Button type="link" onClick={() => setRule(row)}>
                  {m.ruleInfo}
                </Button>
              )}
              {edit && (
                <Button type="link" onClick={() => edit(row)}>
                  {m.edit}
                </Button>
              )}
              {toggle && typeof row.enabled === 'boolean' && <RowCommand kind="toggle" row={row} onDone={reload} />}
              {removable && <RowCommand kind="delete" row={row} onDone={reload} />}
            </Space>
          ),
        },
      ]}
    />
  );
}
function RuleSummary({ row }: { row: Row }) {
  return Array.isArray(row.details)
    ? row.details.map((detail: Row, index: number) => (
        <p key={index}>
          <RefLabel path={refPaths.typeId} id={detail.typeId} /> · {m.fields.daysBefore}{' '}
          {value(detail.daysBefore, 'daysBefore')} · {m.fields.months} {value(detail.months, 'months')}
        </p>
      ))
    : '--';
}
function RuleDrawer({ rule, allowed, close }: { rule?: Row; allowed: readonly string[]; close(): void }) {
  return (
    <Drawer title={m.ruleInfo} open={!!rule} onClose={close} width={600}>
      {rule && (
        <>
          <Fields
            row={rule}
            allowed={allowed}
            keys={['name', 'priority', 'enabled', 'orgIds', 'personIds']}
            labels={{ name: m.ruleName }}
            render={(key) => configValue(rule, key)}
          />
          <h2>{m.flowRule}</h2>
          {allowed.includes('details') &&
            Array.isArray(rule.details) &&
            rule.details.map((detail: Row, index: number) => (
              <section className="contract-card" key={index}>
                <Fields
                  row={detail}
                  keys={['typeId', 'daysBefore', 'months', 'initiatorId', 'skipTypeIds']}
                  render={(key) => detailValue(detail, key)}
                />
              </section>
            ))}
        </>
      )}
    </Drawer>
  );
}
/** 行内启停发完整请求体，编码 / 名称须可读、启用须可写，否则不提供入口。 */
function canToggle(field: (name: string) => { visible: boolean; editable: boolean }) {
  return ['code', 'name'].every((name) => field(name).visible) && field('enabled').editable;
}
function detailValue(detail: Row, key: string) {
  if (key === 'typeId') return <RefLabel path={refPaths.typeId} id={detail.typeId} />;
  if (key === 'skipTypeIds') return <RefLabels path={refPaths.typeId} ids={detail.skipTypeIds} />;
  return value(detail[key], key);
}
function configValue(row: Row, key: string) {
  if (key === 'enabled' && typeof row[key] === 'boolean') return row[key] ? m.enabled : m.disabled;
  if (key === 'details') return <RuleSummary row={row} />;
  if (key === 'orgIds') return <RefLabels path={refPaths.orgId} ids={row.orgIds} />;
  return value(row[key], key);
}
