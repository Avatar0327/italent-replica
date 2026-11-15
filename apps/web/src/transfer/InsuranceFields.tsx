/**
 * F-474-8c-3 调动表单“薪资调整”组的社保三对字段（设计 F-474-8b §1.1、§5；AC-INS-01～04 / 09）：
 * 原值只读、来自社保档案（原值接口，不取联动草稿）；调整值各按自己的字段权限显示 / 只读；6 项都非必填。
 */
import { useState } from 'react';
import { useSession } from '../foundation/Session.js';
import { regionChildren, type RegionNode } from './insurance-api.js';
import { LinkageAccess } from './LinkageFields.js';
import { insuranceText as i, text } from './messages.js';
import type { Choice, LinkageDraft, TransferFormModel } from './types.js';
import {
  useCompanyChoices,
  useInsuranceOrigin,
  usePlanChoices,
  useRegionChildren,
  useRegionName,
} from './useInsurance.js';

type Change = (patch: Partial<LinkageDraft>) => void;
const choiceName = (choices: readonly Choice[], id: string) =>
  choices.find((item) => item.id === id)?.name ?? text.savedValue;

export function InsuranceFields({
  model,
  draft,
  change,
}: {
  model: TransferFormModel;
  draft: LinkageDraft;
  change: Change;
}) {
  const { tenantId } = useSession();
  const { catalog, effectiveDate } = model;
  // 带出的暂存单按单号取原值；换了人就不是这张单
  const businessId = model.draftOf?.employeeId === model.employeeId ? model.draftOf.id : undefined;
  const origin = useInsuranceOrigin(tenantId, model.employeeId, effectiveDate, businessId);
  const originRegion = origin?.regionCode ?? '';
  // 方案候选按缴交地过滤（设计 U3-A）：未调整缴交地时按原缴交地
  const region = draft.adjustedInsuranceRegionCode || originRegion;
  const plans = usePlanChoices(tenantId, region, effectiveDate);
  const otherPlans = usePlanChoices(tenantId, region === originRegion ? '' : originRegion, effectiveDate);
  const companies = useCompanyChoices(tenantId);
  const originRegionName = useRegionName(tenantId, origin?.regionCode);
  // 换了缴交地，原选的方案可能不再适用，清空重选；同一地点不动
  const pickRegion = (code: string) => {
    if (code !== (draft.adjustedInsuranceRegionCode ?? ''))
      change({ adjustedInsuranceRegionCode: code, adjustedInsurancePlanId: '' });
  };
  return (
    <div className="transfer-grid hr-insurance-fields">
      <OriginField name="insuranceRegionCode" label={i.region} value={origin?.regionCode && originRegionName} />
      <LinkageAccess catalog={catalog} codes={['adjustedInsuranceRegionCode']}>
        <RegionPicker tenantId={tenantId} value={draft.adjustedInsuranceRegionCode ?? ''} onChange={pickRegion} />
      </LinkageAccess>
      <OriginField
        name="insurancePlanId"
        label={i.plan}
        value={origin?.planId && choiceName(region === originRegion ? plans : otherPlans, origin.planId)}
      />
      <LinkageAccess catalog={catalog} codes={['adjustedInsurancePlanId']}>
        <ChoiceSelect
          name="adjustedInsurancePlanId"
          label={i.adjustedPlan}
          value={draft.adjustedInsurancePlanId ?? ''}
          choices={plans}
          onChange={(adjustedInsurancePlanId) => change({ adjustedInsurancePlanId })}
        />
      </LinkageAccess>
      <OriginField
        name="insuranceCompanyId"
        label={i.company}
        value={origin?.companyId && choiceName(companies, origin.companyId)}
      />
      <LinkageAccess catalog={catalog} codes={['adjustedInsuranceCompanyId']}>
        <ChoiceSelect
          name="adjustedInsuranceCompanyId"
          label={i.adjustedCompany}
          value={draft.adjustedInsuranceCompanyId ?? ''}
          choices={companies}
          onChange={(adjustedInsuranceCompanyId) => change({ adjustedInsuranceCompanyId })}
        />
      </LinkageAccess>
    </div>
  );
}

/** 原值只读；没有档案、读取失败或无权时三项都显示“--”。 */
function OriginField({ name, label, value }: { name: string; label: string; value: string | null | undefined }) {
  return (
    <div className="hr-readonly-field">
      <span>{label}</span>
      <output name={name}>{value || i.none}</output>
    </div>
  );
}

/** 没有候选（含无权读取）显示“暂无可选项”；已存值不在候选里时保留并显示“已保存的值”，不悄悄换掉。 */
function ChoiceSelect(props: {
  name: string;
  label: string;
  value: string;
  choices: readonly Choice[];
  onChange: (value: string) => void;
}) {
  const { name, label, value, choices, onChange } = props;
  const saved = !!value && !choices.some((item) => item.id === value);
  return (
    <label>
      {label}
      <select name={name} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{choices.length ? i.blank : i.noChoices}</option>
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
        {saved && <option value={value}>{text.savedValue}</option>}
      </select>
    </label>
  );
}

/**
 * 原站地区选择器（设计 §1.1）：“全国”页签起，省 → 市 → 区逐级下钻，按 parent 懒加载；单选，回填只显示末级。
 * 区县级或没有下级的节点（如东莞市）点击即选中。
 */
function RegionPicker({
  tenantId,
  value,
  onChange,
}: {
  tenantId: string;
  value: string;
  onChange: (code: string) => void;
}) {
  // null 表示弹层关闭；数组是已下钻的层级
  const [path, setPath] = useState<readonly RegionNode[] | null>(null);
  const nodes = useRegionChildren(tenantId, path ? (path.at(-1)?.code ?? '') : null);
  const name = useRegionName(tenantId, value);
  const pick = async (node: RegionNode) => {
    const children = node.level >= 3 ? [] : await regionChildren(tenantId, node.code).catch(() => null);
    if (!children) return;
    if (children.length) return setPath([...(path ?? []), node]);
    setPath(null);
    onChange(node.code);
  };
  return (
    <div className="hr-region-picker">
      <span>{i.adjustedRegion}</span>
      <div className="hr-region-value">
        <button
          type="button"
          name="adjustedInsuranceRegionCode"
          aria-expanded={!!path}
          onClick={() => setPath(path ? null : [])}
        >
          {value ? name : i.choose}
        </button>
        {value && (
          <button type="button" onClick={() => onChange('')}>
            {i.clear}
          </button>
        )}
      </div>
      {path && (
        <div className="hr-region-panel" role="group" aria-label={i.adjustedRegion}>
          <div role="tablist">
            <button type="button" role="tab" aria-selected={!path.length} onClick={() => setPath([])}>
              {i.nationwide}
            </button>
            {path.map((node, index) => (
              <button
                key={node.code}
                type="button"
                role="tab"
                aria-selected={index === path.length - 1}
                onClick={() => setPath(path.slice(0, index + 1))}
              >
                {node.name}
              </button>
            ))}
          </div>
          <ul role="tabpanel">
            {nodes.map((node) => (
              <li key={node.code}>
                <button
                  type="button"
                  data-region-code={node.code}
                  aria-pressed={node.code === value}
                  onClick={() => void pick(node)}
                >
                  {node.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
