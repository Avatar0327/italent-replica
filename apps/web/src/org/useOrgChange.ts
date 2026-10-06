import { useState } from 'react';
import { BASE, OrgApiError, orgRequest } from './api.js';
import { changeInput, needsEmploymentChoice, type ChangeModel, type Organization } from './OrgChangeForm.js';
import { text } from './messages.js';
export function useOrgChange({ tenant, date }: { tenant: string; date: string }) {
  const [original, setOriginal] = useState<Organization | null>(null);
  const [parents, setParents] = useState<Organization[]>([]);
  const [model, setModel] = useState<ChangeModel>({ name: '', parentId: '', remarks: '', addEmployment: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  async function select(item: Organization) {
    setNotice('');
    setPending(false);
    setOriginal(null);
    setBusy(true);
    setLocked(false);
    try {
      const org = await orgRequest<Organization>(tenant, `${BASE}/${item.id}?asOf=${date}`);
      if (typeof org.name !== 'string' || !org.parents?.admin?.parentId || !Number.isInteger(org.revision))
        throw new Error(text.missing);
      const parent = await orgRequest<Organization>(tenant, `${BASE}/${org.parents.admin.parentId}?asOf=${date}`);
      setParents([parent]);
      setOriginal(org);
      setModel({ name: org.name, parentId: parent.id, remarks: org.remarks ?? '', addEmployment: '' });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : text.failed);
    } finally {
      setBusy(false);
    }
  }
  async function save(acknowledged = false) {
    if (!original || busy || locked) return;
    if (needsEmploymentChoice(original, model) && !model.addEmployment) {
      setNotice(text.required);
      return;
    }
    const body = changeInput(original, model, date);
    if (Object.keys(body).length === 1) {
      setNotice(text.unchanged);
      return;
    }
    setBusy(true);
    setNotice('');
    let saving = false;
    try {
      if (body.addEmployment && !acknowledged) {
        const result = await orgRequest<{ hasPendingEmployment: boolean }>(
          tenant,
          `${BASE}/${original.id}/employment-preview`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (result.hasPendingEmployment) {
          setPending(true);
          return;
        }
      }
      saving = true;
      await orgRequest(tenant, `${BASE}/${original.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'if-match': String(original.revision), 'idempotency-key': crypto.randomUUID() },
      });
      setPending(false);
      setNotice(text.success);
      setLocked(true);
    } catch (error) {
      setNotice(saveError(error, saving));
      if (saving && (!(error instanceof OrgApiError) || error.status >= 500 || error.status === 409)) setLocked(true);
    } finally {
      setBusy(false);
    }
  }
  return { original, parents, model, busy, notice, pending, locked, select, save, setParents, setModel, setPending };
}

function saveError(error: unknown, saving: boolean) {
  if (error instanceof OrgApiError) return error.status === 409 ? text.conflict : error.message;
  return saving ? text.unknown : text.failed;
}
