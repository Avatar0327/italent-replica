import { useEffect, useState } from 'react';
import { listAll, type OwnerObject, type OwnerOrg } from './api.js';
import { text } from './messages.js';

/** 可选的所属管理单元：只列查看人对该对象的管理单元范围内的组织（DEC-281⑨）。 */
export function useOwnerOrgs(tenantId: string, object: OwnerObject, onError: (message: string) => void) {
  const [options, setOptions] = useState<OwnerOrg[]>([]);
  useEffect(() => {
    void listAll<OwnerOrg>(tenantId, `candidates/owner-orgs?object=${object}`)
      .then(setOptions)
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  }, [tenantId, object, onError]);
  return options;
}

/** 所属管理单元只在新建时选择，建后不可改（编辑时只读显示）。 */
export function OwnerOrgSelect({
  value,
  options,
  readOnly,
  onChange,
}: {
  value: string;
  options: readonly OwnerOrg[];
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {text.ownerOrg}
      <select required disabled={readOnly} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{text.chooseOwnerOrg}</option>
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}（{item.code}）
          </option>
        ))}
        {readOnly && value && !options.some((item) => item.id === value) && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}
