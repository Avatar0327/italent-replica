import {
  RETIREMENT_AUTO_FLEXIBLE_RANGE_KEY,
  STATUTORY_FUNCTION_LABELS,
  type RetirementRulePurpose,
} from '@italent/domain';
import { Button, Table, Tabs, Tag, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import { RefLabels, refPaths } from '../../contracts/references.js';
import { useRead } from '../../contracts/useRead.js';
import { PageState } from '../../foundation/PageState.js';
import { usePermissions } from '../../foundation/Permissions.js';
import { FormCommands } from '../../foundation/forms/useCommandForm.js';
import { otherSettingsEditable } from '../../probation/settings-model.js';
import { SettingBlock, switchSpec } from '../../probation/settings-switch.js';
import { RuleActions, settingsStore } from './commands.js';
import { s } from './messages.js';
import { functionsFor, listPath, parseRules, ruleAccess, settingsObject, type Rule, type RuleAccess } from './model.js';
import { RuleEditor } from './RuleEditor.js';
import '../../exit/exit.css';
import '../../probation/settings.css';

const tabs = [
  { key: 'expected-date', label: s.expected, purpose: 'expected_date' },
  { key: 'flexible-range', label: s.flexible, purpose: 'flexible_range' },
] as const;

export function RetirementSettingsPage() {
  return (
    <FormCommands store={settingsStore}>
      <Routes>
        <Route index element={<Navigate to={tabs[0].key} replace />} />
        <Route path=":tab" element={<SettingsTabs />} />
        <Route path="*" element={<PageState kind="not-found" />} />
      </Routes>
    </FormCommands>
  );
}

function SettingsTabs() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const selected = tabs.find(({ key }) => key === tab);
  if (!selected) return <PageState kind="not-found" />;
  const content = (
    <>
      {selected.purpose === 'flexible_range' && (
        <SettingBlock
          spec={{ ...switchSpec(RETIREMENT_AUTO_FLEXIBLE_RANGE_KEY, s.autoFlexible), hint: s.autoFlexibleHint }}
        />
      )}
      <Rules key={selected.key} purpose={selected.purpose} />
    </>
  );
  return (
    <section className="exit-card">
      <Tabs
        activeKey={selected.key}
        items={tabs.map(({ key, label }) => ({ key, label, children: key === selected.key ? content : null }))}
        onChange={(key) => void navigate(`../${key}`, { relative: 'path' })}
      />
    </section>
  );
}

function useRules(purpose: RetirementRulePurpose) {
  const read = useRead<unknown>(listPath(purpose));
  let rows: Rule[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) rows = parseRules(read.data, purpose);
  } catch (cause) {
    error = cause;
  }
  return { rows, error, loading: read.loading, refresh: read.refresh };
}

function Rules({ purpose }: { purpose: RetirementRulePurpose }) {
  const read = useRules(purpose);
  const permissions = usePermissions(settingsObject);
  const access = ruleAccess(permissions.snapshot.objects[settingsObject], otherSettingsEditable(permissions.menus));
  const [editor, setEditor] = useState<{ row?: Rule }>();
  if (read.error) return <PageState kind="error" error={read.error} retry={read.refresh} />;
  if (read.loading) return <PageState kind="loading" />;
  return (
    <>
      <header className="exit-heading">
        <h1>{s.rules}</h1>
        {access.create && (
          <Button type="primary" onClick={() => setEditor({})}>
            {s.add}
          </Button>
        )}
      </header>
      <Table<Rule>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={read.rows}
        locale={{ emptyText: s.noRules }}
        columns={columnsFor(purpose, access, (row) => setEditor({ row }), read.refresh)}
      />
      {editor && (
        <RuleEditor
          purpose={purpose}
          row={editor.row}
          writable={editor.row ? access.edit : access.create}
          close={() => setEditor(undefined)}
          reload={read.refresh}
        />
      )}
    </>
  );
}

function columnsFor(
  purpose: RetirementRulePurpose,
  access: RuleAccess,
  edit: (row: Rule) => void,
  reload: () => void,
): TableColumnsType<Rule> {
  const hasActions = Object.values(access).some(Boolean);
  return [
    { title: s.fields.priority, dataIndex: 'priority' },
    { title: s.fields.name, dataIndex: 'name' },
    {
      title: s.ruleType,
      key: 'ruleType',
      render: (_value, row) => (
        <>
          {row.ruleType === 'fixed_age' ? s.fixed : s.builtin}
          {row.preset && <Tag>{s.preset}</Tag>}
        </>
      ),
    },
    {
      title: s.fields.orgIds,
      key: 'orgIds',
      render: (_value, row) =>
        row.allOrgs ? s.allOrganizations : <RefLabels path={refPaths.orgId} ids={row.orgIds} />,
    },
    {
      title: s.value,
      key: 'value',
      render: (_value, row) =>
        row.ruleType === 'fixed_age'
          ? s.age(row.retirementAgeYears, row.retirementAgeMonths)
          : functionsFor(purpose)
              .map((key) => STATUTORY_FUNCTION_LABELS[row[key] ?? ''] ?? s.noValue)
              .join(' / '),
    },
    {
      title: s.status,
      key: 'enabled',
      render: (_value, row) => (
        <Tag color={row.enabled ? 'green' : undefined}>{row.enabled ? s.enable : s.disable}</Tag>
      ),
    },
    ...(hasActions
      ? [
          {
            title: s.action,
            key: 'actions',
            render: (_value: unknown, row: Rule) => (
              <RuleActions row={row} access={access} edit={() => edit(row)} reload={reload} />
            ),
          },
        ]
      : []),
  ];
}
