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
      // 只要求 revision：按可见、可编辑字段初始化，不把整个组织对象及旧上级都可见当作整单编辑前提（S1-P2-05）。
      if (!Number.isInteger(org.revision)) throw new Error(text.missing);
      const parentId = org.parents?.admin?.parentId ?? '';
      setParents(parentId ? [await currentParent(tenant, date, parentId)] : []);
      setOriginal(org);
      setModel({ name: org.name ?? '', parentId, remarks: org.remarks ?? '', addEmployment: '' });
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

/** 旧上级超出查看范围（404）时用占位项保留当前值：不改上级就不提交 parents，改上级经上级查询另选。 */
async function currentParent(tenant: string, date: string, parentId: string): Promise<Organization> {
  try {
    return await orgRequest<Organization>(tenant, `${BASE}/${parentId}?asOf=${date}`);
  } catch (error) {
    if (error instanceof OrgApiError && error.status === 404) return { id: parentId, revision: 0 };
    throw error;
  }
}

function saveError(error: unknown, saving: boolean) {
  if (error instanceof OrgApiError) return error.status === 409 ? text.conflict : error.message;
  return saving ? text.unknown : text.failed;
}
