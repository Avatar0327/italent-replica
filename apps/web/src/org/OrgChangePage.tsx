import { useState } from 'react';
import { BASE, orgRequest } from './api.js';
import { editableFields, OrgChangeForm, type Organization } from './OrgChangeForm.js';
import { useOrgChange } from './useOrgChange.js';
import { text } from './messages.js';
import './org.css';

export function OrgChangePage() {
  const [tenant, setTenant] = useState('');
  const [date, setDate] = useState('');
  const [active, setActive] = useState<{ tenant: string; date: string } | null>(null);
  return (
    <main className="org-page">
      <header>
        <h1>{text.title}</h1>
        <a href="/">{text.transfer}</a>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setActive({ tenant: tenant.trim(), date });
        }}
      >
        <label>
          {text.tenant}
          <input required value={tenant} onChange={(event) => setTenant(event.target.value)} />
        </label>
        <label>
          {text.date}
          <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <button type="submit">{text.load}</button>
      </form>
      {active && <ChangeManager key={`${active.tenant}/${active.date}`} tenant={active.tenant} date={active.date} />}
    </main>
  );
}
function ChangeManager({ tenant, date }: { tenant: string; date: string }) {
  const { original, parents, model, busy, notice, pending, locked, select, save, setParents, setModel, setPending } =
    useOrgChange({ tenant, date });
  return (
    <section aria-busy={busy}>
      <OrganizationSearch
        tenant={tenant}
        date={date}
        disabled={busy || pending}
        label={text.target}
        onSelect={select}
      />
      {notice && <p role="status">{notice}</p>}
      {original && (
        <>
          {editableFields(original).parent && (
            <OrganizationSearch
              tenant={tenant}
              date={date}
              disabled={busy || pending || locked}
              label={text.parent}
              onSelect={(org) => {
                setParents((items) => [...items.filter((item) => item.id !== org.id), org]);
                setModel((current) => ({ ...current, parentId: org.id, addEmployment: '' }));
              }}
            />
          )}
          <OrgChangeForm
            original={original}
            model={model}
            parents={parents}
            busy={busy || pending || locked}
            onChange={setModel}
            onSave={() => void save()}
          />
          {locked && (
            <button type="button" disabled={busy} onClick={() => void select(original)}>
              {text.reload}
            </button>
          )}
        </>
      )}
      {pending && (
        <section role="alertdialog" aria-label={text.pending}>
          <h2>{text.pending}</h2>
          <p>{text.pendingDetail}</p>
          <button disabled={busy} onClick={() => void save(true)}>
            {text.acknowledge}
          </button>
          <button disabled={busy} onClick={() => setPending(false)}>
            {text.cancel}
          </button>
        </section>
      )}
    </section>
  );
}
function OrganizationSearch(props: {
  tenant: string;
  date: string;
  label: string;
  disabled: boolean;
  onSelect: (org: Organization) => void;
}) {
  const [name, setName] = useState('');
  const [items, setItems] = useState<Organization[]>([]);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function search(next: number) {
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ asOf: props.date, name, page: String(next), pageSize: '50' });
      const result = await orgRequest<{ items: Organization[] }>(props.tenant, `${BASE}?${query}`);
      setItems(result.items);
      setPage(next);
    } catch {
      setError(text.failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={props.disabled || busy}>
      <legend>{props.label}</legend>
      <label>
        {text.search}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="button" onClick={() => void search(1)}>
        {text.load}
      </button>
      {error && <p role="alert">{error}</p>}
      <ul>
        {items.map((org) => (
          <li key={org.id}>
            <button type="button" onClick={() => props.onSelect(org)}>
              {org.name ?? text.hiddenName}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" disabled={page === 1} onClick={() => void search(page - 1)}>
        {text.previous}
      </button>
      <button type="button" disabled={items.length < 50} onClick={() => void search(page + 1)}>
        {text.next}
      </button>
    </fieldset>
  );
}
