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
  useTicket,
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
  // 选择器按上下文重建：换人、换生效日、换暂存单时旧实例卸载，进行中的选择随之作废（第 2 轮 P2-1）
  const context = [tenantId, model.employeeId, effectiveDate, businessId ?? ''].join(':');
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
        <RegionPicker
          key={context}
          tenantId={tenantId}
          value={draft.adjustedInsuranceRegionCode ?? ''}
          onChange={pickRegion}
        />
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
 * 点击要先等下级查询；关闭、换层级、清除、再点别处或卸载都作废进行中的那次，迟到返回不写弹层也不写草稿。
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
  const ticket = useTicket();
  const go = (next: readonly RegionNode[] | null) => {
    ticket.revoke();
    setPath(next);
  };
  const pick = async (node: RegionNode) => {
    const signal = ticket.issue();
    const children = node.level >= 3 ? [] : await regionChildren(tenantId, node.code).catch(() => null);
    if (signal.aborted || !children) return;
    if (children.length) return setPath([...(path ?? []), node]);
    setPath(null);
    onChange(node.code);
  };
  const clear = () => {
    ticket.revoke();
    onChange('');
  };
  return (
    <div className="hr-region-picker">
      <span>{i.adjustedRegion}</span>
      <div className="hr-region-value">
        <button
          type="button"
          name="adjustedInsuranceRegionCode"
          aria-expanded={!!path}
          onClick={() => go(path ? null : [])}
        >
          {value ? name : i.choose}
        </button>
        {value && (
          <button type="button" onClick={clear}>
            {i.clear}
          </button>
        )}
      </div>
      {path && <RegionPanel path={path} nodes={nodes} value={value} go={go} pick={(node) => void pick(node)} />}
    </div>
  );
}

/** 选择器弹层：页签是已下钻的层级（“全国”起），列表是当前层级的下级。 */
function RegionPanel(props: {
  path: readonly RegionNode[];
  nodes: readonly RegionNode[];
  value: string;
  go: (next: readonly RegionNode[]) => void;
  pick: (node: RegionNode) => void;
}) {
  const { path, nodes, value, go, pick } = props;
  return (
    <div className="hr-region-panel" role="group" aria-label={i.adjustedRegion}>
      <div role="tablist">
        <button type="button" role="tab" aria-selected={!path.length} onClick={() => go([])}>
          {i.nationwide}
        </button>
        {path.map((node, index) => (
          <button
            key={node.code}
            type="button"
            role="tab"
            aria-selected={index === path.length - 1}
            onClick={() => go(path.slice(0, index + 1))}
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
              onClick={() => pick(node)}
            >
              {node.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
