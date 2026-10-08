import { useEffect, useState } from 'react';
import { listAll, type OwnerObject, type OwnerOrg } from './api.js';
import { text } from './messages.js';

/** 当前用户在人才标准应用里的授权管理单元（DEC-294③）。 */
export function useOwnerOrgs(tenantId: string, object: OwnerObject, onError: (message: string) => void) {
  const [options, setOptions] = useState<OwnerOrg[] | undefined>(undefined);
  useEffect(() => {
    void listAll<OwnerOrg>(tenantId, `candidates/owner-orgs?object=${object}`)
      .then(setOptions)
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  }, [tenantId, object, onError]);
  return options;
}

/** 新建请求里的所属管理单元：只在有多个授权管理单元时由用户选择，其余情况交给服务端填写。 */
export function ownerOrgBody(options: readonly OwnerOrg[] | undefined, value: string): { ownerOrgId?: string } {
  return options && options.length > 1 && value ? { ownerOrgId: value } : {};
}

/**
 * 所属管理单元（DEC-294③ 及补充）：由系统按创建人的授权管理单元填写，编辑时不显示、不能转移。
 * 新建时只有一个就不显示；没有就提示无法新建；多个时显示下拉、必须选一个。
 */
export function OwnerUnitField({
  editing,
  value,
  options,
  onChange,
}: {
  editing: boolean;
  value: string;
  options: readonly OwnerOrg[] | undefined;
  onChange: (value: string) => void;
}) {
  if (editing || !options || options.length === 1) return null;
  if (!options.length) return <p role="alert">{text.noOwnerUnit}</p>;
  return (
    <label>
      {text.ownerOrg}
      <select required value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{text.chooseOwnerOrg}</option>
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}（{item.code}）
          </option>
        ))}
      </select>
    </label>
  );
}
