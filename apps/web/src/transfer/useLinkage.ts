/** 联动草稿的候选数据与联动详情（R1-T10）。 */
import { useEffect, useState } from 'react';
import { requestError } from './api.js';
import { loadContractChoices, loadLinkage, retryLinkageItem } from './linkage-api.js';
import type { LinkageItemView, LinkageView, TransferFormModel } from './types.js';

type SetModel = React.Dispatch<React.SetStateAction<TransferFormModel>>;

/** HR 选中员工后读取其可变更的合同；无合同查看权时候选为空，表单提示而不报错。 */
export function useContractChoices(tenantId: string, employeeId: string, initiator: string, setModel: SetModel) {
  useEffect(() => {
    if (initiator === 'employee' || !employeeId) return;
    const controller = new AbortController();
    void loadContractChoices(tenantId, employeeId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setModel((current) => ({ ...current, contracts: result.items }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setModel((current) => ({ ...current, contracts: [] }));
      });
    return () => controller.abort();
  }, [tenantId, employeeId, initiator, setModel]);
}

/** 已保存调动的联动详情；子项重试带子项 revision，409 时重新读取再由用户显式重试。 */
export function useLinkageDetail(tenantId: string, businessId: string | null) {
  const [view, setView] = useState<LinkageView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!businessId) return;
    let active = true;
    void loadLinkage(tenantId, businessId)
      .then((result) => active && setView(result))
      .catch((cause: unknown) => active && setError(requestError(cause)));
    return () => {
      active = false;
    };
  }, [tenantId, businessId, reload]);
  const retry = async (item: LinkageItemView) => {
    setBusy(true);
    setError('');
    try {
      await retryLinkageItem(tenantId, item, crypto.randomUUID());
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  };
  return { view, error, busy, retry };
}
