import { useSession } from '../foundation/Session.js';
import { text as transferText } from '../transfer/messages.js';
import { useRegionName } from '../transfer/useInsurance.js';
import { detailText as d, messages as m } from './messages.js';
import { INSURANCE_ORIGIN } from './named-fields.js';

const REGION = 'adjustedInsuranceRegionCode';

/**
 * F-474-8c-3 AC-INS-08：调整后社保项只在填了时下发，下发即“改变”，新值高亮；
 * “原”只在后端下发对应 insuranceOrigin.* 时显示（披露由后端按社保档案查看权裁剪，前端不判权限），null 显示“—”。
 * 缴交地取字典名称（档案存 code，设计 U6）；方案 / 公司后端只下发 ID，不显示裸 ID。
 */
export function InsuranceField(props: { values: Readonly<Record<string, unknown>>; field: string; label: string }) {
  const { values, field, label } = props;
  const { tenantId } = useSession();
  const originKey = INSURANCE_ORIGIN[field]!;
  const shown = originKey in values;
  const value = useInsuranceText(tenantId, field, values[field]);
  const original = useInsuranceText(tenantId, field, shown ? values[originKey] : null);
  return (
    <div className="approval-field">
      <dt>{label}</dt>
      <dd className="approval-changed">
        <span>{value}</span>
        {shown && <small>{d.original(original)}</small>}
      </dd>
    </div>
  );
}

function useInsuranceText(tenantId: string, field: string, value: unknown) {
  const code = field === REGION && typeof value === 'string' ? value : null;
  const name = useRegionName(tenantId, code);
  if (value === null || value === undefined || value === '') return m.empty;
  return field === REGION ? name : transferText.savedValue;
}
