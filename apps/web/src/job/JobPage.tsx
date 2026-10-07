import { useState } from 'react';
import { initialTenantId } from '../demo/tenant.js';
import { JobForm } from './JobForm.js';
import { text } from './messages.js';
import { useJobManager, useMessages, type JobManagerState } from './useJobManager.js';
export function JobPage() {
  const [tenant, setTenant] = useState(initialTenantId);
  const [active, setActive] = useState(initialTenantId);
  return (
    <main>
      <h1>{text.title}</h1>
      {active ? (
        <JobManager key={active} tenantId={active} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setActive(tenant.trim());
          }}
        >
          <label>
            {text.tenant}
            <input required value={tenant} onChange={(event) => setTenant(event.target.value)} />
          </label>
          <button>{text.enter}</button>
        </form>
      )}
    </main>
  );
}
function JobManager({ tenantId }: { tenantId: string }) {
  const state = useJobManager(tenantId);
  const messages = useMessages(tenantId);
  return (
    <section aria-busy={state.busy}>
      <JobToolbar state={state} />
      {state.error && <p role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {state.unknown && (
        <button disabled={state.busy} onClick={state.retry}>
          {text.retry}
        </button>
      )}
      <JobList state={state} />
      {state.editor && (
        <>
          <JobForm
            kind={state.kind}
            editing={!!state.editor.original}
            originalSequenceId={state.editor.original?.sequenceId ?? null}
            value={state.editor.value}
            sequences={state.sequences}
            posts={state.posts}
            organizations={state.organizations}
            busy={state.locked}
            onChange={(value) => state.setEditor({ original: state.editor!.original, value })}
            onSubmit={state.save}
          />
          <button disabled={state.locked} onClick={() => state.setEditor(null)}>
            {text.cancel}
          </button>
        </>
      )}
      <aside aria-live="polite">
        {messages.map((item) => (
          <div key={item.id}>
            <p>
              {text.completed} {text.updatedCount(item.message.count)} <time>{item.createdAt}</time>
            </p>
            {item.message.skipped?.map((row) => (
              <p key={row.recordId}>
                {row.recordId}：{text.skipReason(row.reason)}
              </p>
            ))}
          </div>
        ))}
      </aside>
    </section>
  );
}
function JobToolbar({ state: s }: { state: JobManagerState }) {
  return (
    <>
      <nav>
        {(['posts', 'positions'] as const).map((item) => (
          <button key={item} disabled={s.locked} onClick={() => s.changeKind(item)}>
            {text[item]}
          </button>
        ))}
      </nav>
      <button disabled={s.locked || !s.list.today} onClick={() => s.edit(null)}>
        {text.create}
      </button>
      <button disabled={s.busy} onClick={s.refresh}>
        {text.refresh}
      </button>
      <button disabled={s.locked || !s.selected.length} onClick={s.sync}>
        {s.kind === 'posts' ? text.syncPosts : text.syncPositions}
      </button>
    </>
  );
}
function JobList({ state: s }: { state: JobManagerState }) {
  return (
    <>
      <ul>
        {s.list.items.map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                disabled={s.locked}
                checked={s.selected.includes(item.id)}
                onChange={(event) =>
                  s.setSelected(
                    event.target.checked ? [...s.selected, item.id] : s.selected.filter((id) => id !== item.id),
                  )
                }
              />
              {item.name}
            </label>
            <button disabled={s.locked} onClick={() => s.edit(item)}>
              {text.edit}
            </button>
          </li>
        ))}
      </ul>
      <button disabled={s.locked || s.page === 1} onClick={() => s.changePage(s.page - 1)}>
        {text.previous}
      </button>
      <button disabled={s.locked || s.list.items.length < 50} onClick={() => s.changePage(s.page + 1)}>
        {text.next}
      </button>
    </>
  );
}
