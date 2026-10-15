import type { ReactNode } from 'react';
import { EmploymentFields, SelectionFields, transferBlocked } from '../self-service/shared/TransferForm.js';
import {
  hrActionLabels,
  hrActionState,
  hrFormActions,
  hrSections,
  type HrFormAction,
  type HrFormMode,
  type HrSection,
} from './hr-form-model.js';
import { ContractDetails, DutyFields, LinkageAccess, PersonSelect } from './LinkageFields.js';
import { hrFormText as h, linkageText, text } from './messages.js';
import type { LinkageDraft, TransferFormProps } from './types.js';

export interface HrTransferFormProps extends TransferFormProps {
  readonly mode: HrFormMode;
  /** 任职记录对象的新建写权限（create + 可编辑字段），由页面按当前权限算出。 */
  readonly writable: boolean;
  readonly onCancel: () => void;
}

/**
 * HR 全页表单按原站四个区块：调动信息 / 任职调整 / 薪资调整 / 合同变更，右侧锚点导航（#333 第 1 轮 P2-5）。
 * 底部按钮按入口区分：“调动”为取消 / 保存，“他人调动申请”为取消 / 暂存 / 提交（P2-1）。
 */
export function HrTransferForm(props: HrTransferFormProps) {
  return (
    <form className="hr-transfer-form" onSubmit={(event) => event.preventDefault()} aria-label={text.subtitle}>
      <div className="hr-transfer-sections">
        <InfoSection {...props} />
        <AdjustmentSection {...props} />
        <SalarySection {...props} />
        <ContractSection {...props} />
        <HrActions {...props} />
      </div>
      <HrAnchorNav />
    </form>
  );
}

function HrAnchorNav() {
  return (
    <nav className="hr-transfer-anchors" aria-label={h.sections}>
      {hrSections.map((section) => (
        <button
          key={section.key}
          type="button"
          onClick={() => document.getElementById(section.id)?.scrollIntoView({ block: 'start' })}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

function SectionFrame({ section, busy, children }: { section: HrSection; busy?: boolean; children: ReactNode }) {
  const meta = hrSections.find((item) => item.key === section)!;
  return (
    <fieldset id={meta.id} disabled={busy} className="hr-transfer-section">
      <legend>{meta.label}</legend>
      {children}
    </fieldset>
  );
}

function InfoSection(props: HrTransferFormProps) {
  const { model, busy, onLinkage } = props;
  const draft = model.linkage;
  const employee = model.employees.find((item) => item.id === model.employeeId);
  const people = model.employees.filter((item) => item.id !== model.employeeId);
  const change = (patch: Partial<LinkageDraft>) => onLinkage?.(patch);
  return (
    <SectionFrame section="info" busy={busy}>
      <SelectionFields {...props} />
      <div className="transfer-grid">
        {draft && (
          <LinkageAccess catalog={model.catalog} codes={['handoverPersonId']}>
            <PersonSelect
              name="handoverPersonId"
              label={linkageText.handoverPerson}
              value={draft.handoverPersonId}
              people={people}
              onChange={(handoverPersonId) => change({ handoverPersonId })}
            />
          </LinkageAccess>
        )}
        {employee && (
          <div className="hr-readonly-field">
            <span>{h.jobNumber}</span>
            <output name="jobNumber">{employee.code}</output>
          </div>
        )}
        {draft && <InfoLinkage {...props} draft={draft} change={change} />}
      </div>
      <p className="hr-form-gap">{h.infoGap}</p>
    </SectionFrame>
  );
}

interface LinkageProps extends HrTransferFormProps {
  readonly draft: LinkageDraft;
  readonly change: (patch: Partial<LinkageDraft>) => void;
}
function InfoLinkage({ model, draft, change, onWithEstablishment }: LinkageProps) {
  return (
    <>
      <LinkageAccess catalog={model.catalog} codes={['adjustSalary']}>
        <YesNo
          name="adjustSalary"
          label={h.adjustSalary}
          value={draft.adjustSalary}
          onChange={(adjustSalary) => change({ adjustSalary })}
        />
      </LinkageAccess>
      <LinkageAccess catalog={model.catalog} codes={['isChangeContract', 'contractChange']}>
        <YesNo
          name="changeContract"
          label={h.changeContract}
          value={draft.changeContract}
          onChange={(changeContract) => change({ changeContract })}
        />
      </LinkageAccess>
      <LinkageAccess catalog={model.catalog} codes={['withEstablishment']}>
        <YesNo
          name="withEstablishment"
          label={h.withEstablishment}
          value={model.withEstablishment === true}
          onChange={(value) => onWithEstablishment?.(value)}
        />
      </LinkageAccess>
      <LinkageAccess catalog={model.catalog} codes={['onTrialStartDate']}>
        <label>
          {linkageText.trialStartDate}
          <input
            name="onTrialStartDate"
            type="date"
            value={draft.onTrialStartDate}
            onChange={(event) => change({ onTrialStartDate: event.target.value })}
          />
        </label>
      </LinkageAccess>
      <LinkageAccess catalog={model.catalog} codes={['onTrialMonths']}>
        <label>
          {linkageText.trialMonths}
          <input
            name="onTrialMonths"
            type="number"
            min={1}
            max={60}
            value={draft.onTrialMonths ?? ''}
            onChange={(event) => change({ onTrialMonths: event.target.value ? Number(event.target.value) : null })}
          />
        </label>
      </LinkageAccess>
    </>
  );
}

/** 原站“是 / 否”单选；默认否。 */
function YesNo(props: { name: string; label: string; value: boolean; onChange: (value: boolean) => void }) {
  const { name, label, value, onChange } = props;
  return (
    <div role="radiogroup" aria-label={label} className="hr-yes-no">
      <span>
        {label}
        {text.required}
      </span>
      <label>
        <input type="radio" name={name} value="true" checked={value} onChange={() => onChange(true)} />
        {text.yes}
      </label>
      <label>
        <input type="radio" name={name} value="false" checked={!value} onChange={() => onChange(false)} />
        {text.no}
      </label>
    </div>
  );
}

function AdjustmentSection(props: HrTransferFormProps) {
  const { model, busy, onLinkage } = props;
  const people = model.employees.filter((item) => item.id !== model.employeeId);
  return (
    <SectionFrame section="adjustment" busy={busy}>
      {model.preview ? <EmploymentFields {...props} /> : <p>{text.readyHint}</p>}
      {model.linkage && model.preview && (
        <LinkageAccess catalog={model.catalog} codes={['dutyTransfer']}>
          <DutyFields draft={model.linkage} people={people} change={(patch) => onLinkage?.(patch)} />
        </LinkageAccess>
      )}
    </SectionFrame>
  );
}

/** 原站选“否”时本区块仍显示；接口只记“是否调整薪资”标志（DEC-002），社保类字段列入缺口。 */
function SalarySection({ model, busy }: HrTransferFormProps) {
  return (
    <SectionFrame section="salary" busy={busy}>
      <p>{model.linkage?.adjustSalary ? linkageText.salaryHint : h.salaryOff}</p>
      <p className="hr-form-gap">{h.salaryGap}</p>
    </SectionFrame>
  );
}

function ContractSection({ model, busy, onLinkage }: HrTransferFormProps) {
  const draft = model.linkage;
  return (
    <SectionFrame section="contract" busy={busy}>
      {draft?.changeContract ? (
        <LinkageAccess catalog={model.catalog} codes={['isChangeContract', 'contractChange']}>
          <div className="transfer-grid">
            <ContractDetails draft={draft} contracts={model.contracts ?? []} change={(patch) => onLinkage?.(patch)} />
          </div>
        </LinkageAccess>
      ) : (
        <p>{h.contractOff}</p>
      )}
      <p className="hr-form-gap">{h.contractGap}</p>
    </SectionFrame>
  );
}

function HrActions(props: HrTransferFormProps) {
  const { model, mode, writable, onAction, onCancel } = props;
  const state = hrActionState({ mode, writable, blocked: transferBlocked(props), preview: model.preview });
  const run: Record<HrFormAction, () => void> = {
    cancel: onCancel,
    draft: () => onAction?.('draft'),
    submit: () => onAction?.('submit'),
    save: () => onAction?.('direct'),
  };
  return (
    <div className="transfer-actions hr-transfer-actions">
      {model.preview?.requiredFieldsUnavailable && <p role="alert">{text.requiredUnavailable}</p>}
      {state.hint && <p role="note">{state.hint}</p>}
      {hrFormActions[mode].map((action) => (
        <button
          key={action}
          type="button"
          className={action === 'cancel' ? undefined : 'hr-primary'}
          data-button-code={action === 'save' ? 'Employment.Tranfer' : undefined}
          disabled={!state.enabled[action]}
          onClick={run[action]}
        >
          {hrActionLabels[action]}
        </button>
      ))}
    </div>
  );
}
