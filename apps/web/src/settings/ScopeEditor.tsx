import { Button, Checkbox, Input, Select, Space } from 'antd';
import { useState } from 'react';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { useApiClient } from '../foundation/Session.js';
import { settingsApi } from './api.js';
import { base, validId, type OrgRange, type Scope } from './model.js';
import { Facts, Notice } from './parts.js';
import { useResource } from './useResource.js';
import { useWrite } from './useWrite.js';
import { m } from './messages.js';
export function RangeInput({ value = [], onChange }: { value?: OrgRange[]; onChange?(value: OrgRange[]): void }) {
  const change = (index: number, patch: Partial<OrgRange>) =>
    onChange?.(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div>
      <p>{m.orgHelp}</p>
      {value.map((row, index) => (
        <div className="settings-range" key={index}>
          <Input
            aria-label={`${m.orgId} ${index + 1}`}
            value={row.orgId}
            onChange={(event) => change(index, { orgId: event.target.value })}
          />
          <Select
            aria-label={`${m.dimension} ${index + 1}`}
            value={row.dimension}
            options={[
              { value: 'admin', label: m.admin },
              { value: 'business', label: m.business },
              { value: 'product', label: m.finance },
              { value: 'reserve4', label: m.reserve4 },
              { value: 'reserve5', label: m.reserve5 },
            ]}
            onChange={(dimension) => change(index, { dimension })}
          />
          <Checkbox
            checked={row.includeDescendants}
            onChange={(event) => change(index, { includeDescendants: event.target.checked })}
          >
            {m.descendants}
          </Checkbox>
          <Button type="link" onClick={() => onChange?.(value.filter((_, i) => i !== index))}>
            {m.remove}
          </Button>
        </div>
      ))}
      <Button
        disabled={value.length >= 200}
        onClick={() => onChange?.([...value, { orgId: '', dimension: 'admin', includeDescendants: false }])}
      >
        {m.addRange}
      </Button>
    </div>
  );
}
export function ScopeEditor({ initialUser = '' }: { initialUser?: string }) {
  const [userId, setUserId] = useState(initialUser);
  const [appCode, setAppCode] = useState('');
  const [target, setTarget] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <section className="settings-scope-query">
      <h2>{m.scope}</h2>
      <Notice text={m.scopeNotice} />
      <Space wrap>
        <Input
          aria-label={m.userId}
          placeholder={m.userHint}
          value={userId}
          onChange={(event) => {
            setUserId(event.target.value);
            setTarget('');
          }}
        />
        <Input
          aria-label={m.appCode}
          placeholder={m.appHint}
          value={appCode}
          onChange={(event) => {
            setAppCode(event.target.value);
            setTarget('');
          }}
        />
        <Button
          onClick={() => {
            const valid = validId(userId) && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(appCode);
            setInvalid(!valid);
            if (valid) setTarget(`${base}/scopes/${userId}/${appCode}`);
          }}
        >
          {m.loadScope}
        </Button>
      </Space>
      {invalid && <p role="alert">{m.invalid}</p>}
      {target ? <ScopeResult key={target} path={target} /> : <p>{m.scopeEmpty}</p>}
    </section>
  );
}
function ScopeResult({ path }: { path: string }) {
  const resource = useResource<Scope>(path);
  const [edit, setEdit] = useState(false);
  if (resource.error) return <PageState kind="error" error={resource.error} retry={resource.refresh} />;
  const scope = resource.data;
  if (!scope) return <PageState kind="loading" />;
  return (
    <>
      <Facts
        items={[
          [m.userId, scope.userId],
          [m.appCode, scope.appCode],
          [m.scope, scopeDescription(scope)],
          [m.revision, scope.revision],
        ]}
      />
      <Button
        onClick={() => {
          setEdit(true);
        }}
      >
        {m.edit}
      </Button>
      <Button onClick={resource.refresh}>{m.refresh}</Button>
      {edit && <ScopeForm scope={scope} close={() => setEdit(false)} refresh={resource.refresh} />}
    </>
  );
}

function scopeDescription(scope: Scope) {
  if (scope.kind === 'default') return m.defaultScope;
  if (scope.kind === 'mou') return scope.mouId;
  return scope.orgRanges
    .map((r) => `${r.orgId} (${r.dimension}, ${r.includeDescendants ? m.descendants : m.no})`)
    .join('、');
}

function ScopeForm({ scope, close, refresh }: { scope: Scope; close(): void; refresh(): void }) {
  const api = useApiClient();
  const writer = useWrite();
  const [kind, setKind] = useState<Scope['kind']>(scope.kind);
  const access = { visible: true, editable: true };
  return (
    <FormOverlay
      open
      recordKey={`${scope.userId}/${scope.appCode}/${scope.revision}`}
      title={m.scope}
      initialValues={{ ...scope }}
      onClose={() => close()}
      onRefresh={() => {
        close();
        refresh();
      }}
      groups={[
        {
          title: m.scopeNotice,
          fields: [
            {
              name: 'kind',
              label: m.scope,
              access,
              control: (
                <Select
                  onChange={setKind}
                  options={[
                    { value: 'default', label: m.defaultScope },
                    { value: 'mou', label: m.mouScope },
                    { value: 'org_range', label: m.orgScope },
                  ]}
                />
              ),
            },
            ...(kind === 'mou'
              ? [
                  {
                    name: 'mouId',
                    label: m.mouId,
                    access,
                    control: <Input />,
                    rules: [
                      {
                        required: true,
                        validator: async (_: unknown, value: unknown) => {
                          if (!validId(value)) throw new Error(m.invalid);
                        },
                      },
                    ],
                  },
                ]
              : []),
            ...(kind === 'org_range' ? [{ name: 'orgRanges', label: m.ranges, access, control: <RangeInput /> }] : []),
          ],
        },
      ]}
      onSubmit={(values) =>
        writer.run(async () => {
          await settingsApi(api).saveScope(scope, values);
          refresh();
        })
      }
    />
  );
}
