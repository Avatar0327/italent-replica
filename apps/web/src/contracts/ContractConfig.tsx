import { Alert, Button, Drawer, Space, Switch, Table } from 'antd';
import { useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { contractTypes } from '../demo-stubs/contracts.js';
import { configObjects, value, type Config, type Row } from './model.js';
import { useRead } from './useRead.js';
import { m } from './messages.js';
import { Coming, DemoNote, Fields } from './parts.js';
export function ContractConfig({ kind }: { kind: Config }) {
  const permission = usePermissions(configObjects[kind]);
  const allowed = permission.snapshot.objects[configObjects[kind]]?.viewableFields ?? [];
  const [page, setPage] = useState(1);
  const [demo, setDemo] = useState(false);
  const [rule, setRule] = useState<Row>();
  const path = kind === 'types' ? `/master-data/types?page=${page}&pageSize=15` : `/${kind}`;
  const result = useRead<Row & { items?: Row[] }>(`/api/tenant/contracts${path}`);
  const settingPermission = usePermissions(configObjects.settings);
  const settings = useRead<Row>(
    kind === 'rules' && settingPermission.snapshot.objects[configObjects.settings]
      ? '/api/tenant/contracts/settings'
      : null,
  );
  const rows = kind === 'types' && demo ? contractTypes : (result.data?.items ?? []);
  return (
    <section className="contract-card">
      <header className="contract-heading">
        <h1>{m[kind]}</h1>
        <Coming labels={[kind === 'settings' ? m.save : m.create]} />
      </header>
      {!!result.error && <PageState kind="error" error={result.error} retry={result.refresh} />}
      {!result.error && result.loading && <PageState kind="loading" />}
      {!result.error && !result.loading && (
        <>
          {kind === 'settings' ? (
            <SettingsFields row={result.data ?? {}} allowed={allowed} />
          ) : (
            <>
              {kind === 'rules' && (
                <RenewalSwitch settings={settings} visible={settingPermission.field('autoRenew').visible} />
              )}
              {kind === 'types' && (
                <Space>
                  <p>{m.orderHint}</p>
                  <Button onClick={() => setDemo((v) => !v)}>{demo ? m.live : m.sample}</Button>
                </Space>
              )}
              {demo && <DemoNote />}
              <ConfigTable kind={kind} rows={rows} demo={demo} allowed={allowed} setRule={setRule} />
              {kind === 'types' && (
                <Space>
                  <Button disabled={demo || page === 1} onClick={() => setPage((n) => n - 1)}>
                    {m.previous}
                  </Button>
                  <span>{page}</span>
                  <Button disabled={demo || rows.length < 15} onClick={() => setPage((n) => n + 1)}>
                    {m.next}
                  </Button>
                </Space>
              )}
            </>
          )}
        </>
      )}
      <RuleDrawer rule={rule} allowed={allowed} close={() => setRule(undefined)} />
    </section>
  );
}
function SettingsFields({ row, allowed }: { row: Row; allowed: readonly string[] }) {
  return (
    <>
      <Alert type="info" message={m.settingHint} />
      <Fields
        row={row}
        allowed={allowed}
        keys={[
          'autoTerminate',
          'postExitTypeIds',
          'indefiniteTypeIds',
          'accumulateRehire',
          'renewalTypeIds',
          'autoNumber',
          'uniqueFields',
        ]}
      />
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
  demo,
  allowed,
  setRule,
}: {
  kind: Config;
  rows: Row[];
  demo: boolean;
  allowed: readonly string[];
  setRule(row: Row): void;
}) {
  const keys =
    kind === 'types'
      ? ['code', 'name', 'enabled', 'displayOrder']
      : ['priority', 'name', 'orgIds', 'personIds', 'details'];
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
          .filter((key) => demo || allowed.includes(key) || key === 'displayOrder')
          .map((key) => ({
            key,
            title:
              ({ name: kind === 'types' ? m.typeName : m.ruleName, code: m.typeCode } as Record<string, string>)[key] ??
              m.fields[key],
            width: kind === 'types' ? 254 : (({ priority: 132 } as Record<string, number>)[key] ?? 222),
            render: (_: unknown, row: Row) => (key === 'details' ? <RuleSummary row={row} /> : configValue(row, key)),
          })),
        ...(kind === 'rules'
          ? [
              {
                key: 'open',
                title: m.ruleInfo,
                width: 152,
                render: (_: unknown, row: Row) => (
                  <Button type="link" onClick={() => setRule(row)}>
                    {m.ruleInfo}
                  </Button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
function RuleSummary({ row }: { row: Row }) {
  return Array.isArray(row.details)
    ? row.details.map((detail: Row, index: number) => (
        <p key={index}>
          {value(detail.typeId, 'typeId')} · {m.fields.daysBefore} {value(detail.daysBefore, 'daysBefore')} ·{' '}
          {m.fields.months} {value(detail.months, 'months')}
        </p>
      ))
    : '--';
}
function RuleDrawer({ rule, allowed, close }: { rule?: Row; allowed: readonly string[]; close(): void }) {
  return (
    <Drawer title={m.ruleInfo} open={!!rule} onClose={close} width={600}>
      {rule && (
        <>
          <Fields row={rule} allowed={allowed} keys={['name', 'priority', 'orgIds', 'personIds', 'enabled']} />
          <h2>{m.flowRule}</h2>
          {allowed.includes('details') &&
            Array.isArray(rule.details) &&
            rule.details.map((detail: Row, index: number) => (
              <section className="contract-card" key={index}>
                <Fields row={detail} keys={['typeId', 'daysBefore', 'months', 'initiatorId', 'skipTypeIds']} />
              </section>
            ))}
          <Coming labels={[m.save]} />
        </>
      )}
    </Drawer>
  );
}

function configValue(row: Row, key: string) {
  if (key === 'enabled' && typeof row[key] === 'boolean') return row[key] ? m.enabled : m.disabled;
  return value(row[key], key);
}
