/** 调动表单的联动区块（R1-T10，`13` §7 HR 端“他人调动申请”表单）：只在 HR 入口出现，本人申请没有（`12` 附录）。 */
import type { ReactNode } from 'react';
import { linkageText } from './messages.js';
import type { Choice, ContractChoice, LinkageDraft, TransferFormProps, TransferCatalog } from './types.js';

export function LinkageFields({ model, busy, onLinkage }: TransferFormProps) {
  const draft = model.linkage;
  if (!draft || model.initiator === 'employee' || !model.preview) return null;
  const change = (patch: Partial<LinkageDraft>) => onLinkage?.(patch);
  const people = model.employees.filter((employee) => employee.id !== model.employeeId);
  return (
    <fieldset disabled={busy} className="transfer-linkage">
      <legend>{linkageText.section}</legend>
      <div className="transfer-grid">
        <LinkageAccess catalog={model.catalog} codes={['isChangeContract', 'contractChange']}>
          <ContractFields draft={draft} contracts={model.contracts ?? []} change={change} />
        </LinkageAccess>
        <LinkageAccess catalog={model.catalog} codes={['adjustSalary']}>
          <label>
            <input
              type="checkbox"
              name="adjustSalary"
              checked={draft.adjustSalary}
              onChange={(event) => change({ adjustSalary: event.target.checked })}
            />
            {linkageText.adjustSalary}
          </label>
        </LinkageAccess>
        {draft.adjustSalary && (
          <LinkageAccess catalog={model.catalog} codes={['adjustSalary']}>
            <p>{linkageText.salaryHint}</p>
          </LinkageAccess>
        )}
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
        <LinkageAccess catalog={model.catalog} codes={['handoverPersonId']}>
          <PersonSelect
            name="handoverPersonId"
            label={linkageText.handoverPerson}
            value={draft.handoverPersonId}
            people={people}
            onChange={(handoverPersonId) => change({ handoverPersonId })}
          />
        </LinkageAccess>
      </div>
      <LinkageAccess catalog={model.catalog} codes={['dutyTransfer']}>
        <DutyFields draft={draft} people={people} change={change} />
      </LinkageAccess>
    </fieldset>
  );
}

function ContractFields(props: {
  draft: LinkageDraft;
  contracts: readonly ContractChoice[];
  change: (patch: Partial<LinkageDraft>) => void;
}) {
  const { draft, contracts, change } = props;
  const field = (code: string, value: string | number | null) =>
    change({ contractFields: { ...draft.contractFields, [code]: value } });
  return (
    <>
      <label>
        <input
          type="checkbox"
          name="changeContract"
          checked={draft.changeContract}
          onChange={(event) => change({ changeContract: event.target.checked })}
        />
        {linkageText.changeContract}
      </label>
      {draft.changeContract && (
        <>
          <label>
            {linkageText.contractTarget}
            <select
              name="contractTargetId"
              value={draft.contractTargetId}
              onChange={(event) => change({ contractTargetId: event.target.value })}
            >
              <option value="">—</option>
              {contracts.map((contract, index) => (
                <option key={contract.id} value={contract.id}>
                  {contract.name ?? linkageText.contractOption(index + 1)}
                </option>
              ))}
            </select>
          </label>
          {!contracts.length && <p>{linkageText.noContracts}</p>}
          <label>
            {linkageText.contractEndDate}
            <input
              name="contractEndDate"
              type="date"
              value={String(draft.contractFields.endDate ?? '')}
              onChange={(event) => field('endDate', event.target.value || null)}
            />
          </label>
          <label>
            {linkageText.contractTermMonths}
            <input
              name="contractTermMonths"
              type="number"
              min={1}
              value={String(draft.contractFields.termMonths ?? '')}
              onChange={(event) => field('termMonths', event.target.value ? Number(event.target.value) : null)}
            />
          </label>
          <label>
            {linkageText.contractSigningDate}
            <input
              name="contractSigningDate"
              type="date"
              value={String(draft.contractFields.signingDate ?? '')}
              onChange={(event) => field('signingDate', event.target.value || null)}
            />
          </label>
        </>
      )}
    </>
  );
}

function DutyFields(props: {
  draft: LinkageDraft;
  people: readonly Choice[];
  change: (patch: Partial<LinkageDraft>) => void;
}) {
  const { draft, people, change } = props;
  return (
    <div className="transfer-grid">
      <h3>{linkageText.dutyTransfer}</h3>
      <PersonSelect
        name="dutyReceiverId"
        label={linkageText.dutyReceiver}
        value={draft.dutyReceiverId}
        people={people}
        onChange={(dutyReceiverId) => change({ dutyReceiverId })}
      />
      <label>
        {linkageText.dutySubordinates}
        <select
          name="dutySubordinateIds"
          multiple
          value={[...draft.dutySubordinateIds]}
          onChange={(event) =>
            change({ dutySubordinateIds: Array.from(event.target.selectedOptions, (option) => option.value) })
          }
        >
          {people
            .filter((person) => person.id !== draft.dutyReceiverId)
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          name="transferDepartmentHead"
          checked={draft.transferDepartmentHead}
          onChange={(event) => change({ transferDepartmentHead: event.target.checked })}
        />
        {linkageText.dutyDepartmentHead}
      </label>
    </div>
  );
}

function PersonSelect(props: {
  name: string;
  label: string;
  value: string;
  people: readonly Choice[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {props.label}
      <select name={props.name} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">—</option>
        {props.people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function LinkageAccess({
  catalog,
  codes,
  children,
}: {
  catalog: TransferCatalog;
  codes: string[];
  children: ReactNode;
}) {
  // 与调动 catalog 的基本字段一致：显式权限清单决定显示和只读；缺省沿用既有全字段契约。
  if (catalog.viewableFields && !codes.every((code) => catalog.viewableFields!.includes(code))) return null;
  const readonly = !!catalog.editableFields && !codes.every((code) => catalog.editableFields!.includes(code));
  return (
    <fieldset className="transfer-linkage-field" disabled={readonly}>
      {children}
    </fieldset>
  );
}
