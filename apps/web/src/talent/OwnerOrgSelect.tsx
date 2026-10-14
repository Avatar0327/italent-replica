import type { OwnerObject, OwnerOrg } from './api.js';
import { text } from './messages.js';
import { CandidateNotice, useCandidates, type CandidateState } from './useCandidates.js';

/** 当前用户在人才标准应用里的授权管理单元（DEC-294③）。 */
export function useOwnerOrgs(tenantId: string, object: OwnerObject) {
  return useCandidates<OwnerOrg>(tenantId, `candidates/owner-orgs?object=${object}`);
}

/** 新建请求里的所属管理单元：只在有多个授权管理单元时由用户选择，其余情况交给服务端填写。 */
export function ownerOrgBody(options: readonly OwnerOrg[] | undefined, value: string): { ownerOrgId?: string } {
  return options && options.length > 1 && value ? { ownerOrgId: value } : {};
}

/** 下拉里的单元名称：看不到组织名称 / 编码时（DEC-309）退回显示 ID。 */
const unitLabel = (item: OwnerOrg) =>
  item.name ? `${item.name}${item.code ? `（${item.code}）` : ''}` : (item.code ?? item.id);

/**
 * 所属管理单元（DEC-294③ 及补充）：由系统按创建人 / 添加人的授权管理单元填写，编辑时不显示、不能转移。
 * 新建时只有一个就不显示；没有就提示无法新建；多个时显示下拉、必须选一个。label 用于“新加指标的所属管理单元”。
 */
export function OwnerUnitField({
  editing,
  value,
  options,
  onChange,
  label = text.ownerOrg,
  state,
}: {
  editing: boolean;
  value: string;
  options: readonly OwnerOrg[] | undefined;
  onChange: (value: string) => void;
  label?: string;
  state?: CandidateState<OwnerOrg>;
}) {
  if (editing) return null;
  if (!options) return <CandidateNotice label={label} state={state ?? { items: undefined, status: 'loading' }} />;
  if (options.length === 1) return null;
  if (!options.length) return <p role="alert">{text.noOwnerUnit}</p>;
  return (
    <label>
      {label}
      <select required value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{text.chooseOwnerOrg}</option>
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {unitLabel(item)}
          </option>
        ))}
      </select>
    </label>
  );
}
