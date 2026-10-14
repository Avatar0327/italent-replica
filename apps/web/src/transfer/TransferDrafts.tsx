import { Alert, Button, Descriptions, Drawer, Space } from 'antd';
import { useEffect, useState } from 'react';
import { Can, useSession } from '../foundation/index.js';
import { EMPLOYMENT_API, TRANSFER_API, requestError, submitSavedTransfer, transferRequest } from './api.js';
import { draftRows, type DraftOptions, type SavedDraft } from './draft-fields.js';
import { hrSessionChanged, readHrSession } from './hr-session.js';
import { text as m } from './messages.js';
import { useHrWrite } from './useHrWrite.js';

export function TransferDrafts() {
  const session = useSession();
  const scope = JSON.stringify([session.tenantId, session.identityKey]);
  return <SessionDrafts key={scope} scope={scope} tenantId={session.tenantId} />;
}
function SessionDrafts({ scope, tenantId }: { scope: string; tenantId: string }) {
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  useEffect(() => {
    const refresh = () => {
      try {
        setIds(readHrSession(scope).drafts);
        setError('');
      } catch {
        setIds([]);
        setError(m.recoveryUnavailable);
      }
    };
    refresh();
    window.addEventListener(hrSessionChanged, refresh);
    return () => window.removeEventListener(hrSessionChanged, refresh);
  }, [scope]);
  return (
    <section>
      <h2>{m.sessionDrafts}</h2>
      <p>{m.sessionDraftHint}</p>
      {error && <Alert type="error" message={error} />}
      {!ids.length && <p>{m.noDrafts}</p>}
      <Space wrap>
        {ids.map((id, index) => (
          <Button key={id} onClick={() => setSelected(id)}>
            {m.openDraft(index + 1)}
          </Button>
        ))}
      </Space>
      <Drawer open={!!selected} title={m.draftTitle} width={900} onClose={() => setSelected('')} destroyOnHidden>
        {selected && <DraftDetail key={selected} scope={scope} tenantId={tenantId} id={selected} />}
      </Drawer>
    </section>
  );
}
interface DraftView {
  business: SavedDraft;
  options: DraftOptions;
}
function DraftDetail({ scope, tenantId, id }: { scope: string; tenantId: string; id: string }) {
  const [view, setView] = useState<DraftView>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mustRead, setMustRead] = useState(false);
  const write = useHrWrite(scope);
  useEffect(() => {
    const controller = new AbortController();
    setView(undefined);
    setLoading(true);
    setError('');
    void Promise.all([
      transferRequest<SavedDraft>(tenantId, `${EMPLOYMENT_API}/businesses/${id}`, { signal: controller.signal }),
      transferRequest<{ businessId: string; revision?: number; options?: DraftOptions | null }>(
        tenantId,
        `${TRANSFER_API}/${id}/linkage`,
        { signal: controller.signal },
      ),
    ])
      .then(([business, linkage]) => {
        if (controller.signal.aborted) return;
        if (
          business.id !== id ||
          linkage.businessId !== id ||
          !Number.isInteger(business.revision) ||
          (linkage.revision !== undefined && linkage.revision !== business.revision)
        )
          throw new Error(m.failed);
        setView({ business, options: linkage.options ?? {} });
        setMustRead(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, id, reload]);
  if (write.processing) return <p role="status">{m.processing}</p>;
  if (write.result) return <p role="status">{m.submitted}</p>;
  return (
    <section aria-busy={loading}>
      <p>{m.draftHint}</p>
      {(error || write.error) && <Alert type="error" message={error || write.error} />}
      {loading && <p role="status">{m.loading}</p>}
      {view && (
        <Descriptions
          bordered
          column={1}
          items={draftRows(view.business, view.options).map((row) => ({
            key: row.key,
            label: row.label,
            children: <span data-testid={`draft-field-${row.key}`}>{row.value}</span>,
          }))}
        />
      )}
      <Space>
        <Button disabled={loading} onClick={() => setReload((value) => value + 1)}>
          {m.reloadDraft}
        </Button>
        {view?.business.status === 'draft' && (
          <Can object="TenantBase.EmploymentRecord" button="Transfer.Hr">
            <Button
              type="primary"
              disabled={loading || mustRead}
              onClick={() => {
                setMustRead(true);
                void write.run((command) => submitSavedTransfer(tenantId, view.business, command));
              }}
            >
              {m.submitDraft}
            </Button>
          </Can>
        )}
      </Space>
    </section>
  );
}
