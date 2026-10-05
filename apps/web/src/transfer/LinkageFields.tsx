/** 调动表单的联动区块（R1-T10，`13` §7 HR 端“他人调动申请”表单）：只在 HR 入口出现，本人申请没有（`12` 附录）。 */
import { linkageText } from './messages.js';
import type { Choice, LinkageDraft, TransferFormProps } from './types.js';

export function LinkageFields({ model, busy, onLinkage }: TransferFormProps) {
  const draft = model.linkage;
  if (!draft || model.initiator === 'employee' || !model.preview) return null;
  const change = (patch: Partial<LinkageDraft>) => onLinkage?.(patch);
  const people = model.employees.filter((employee) => employee.id !== model.employeeId);
  return (
    <fieldset disabled={busy} className="transfer-linkage">
      <legend>{linkageText.section}</legend>
      <div className="transfer-grid">
        <ContractFields draft={draft} contracts={model.contracts ?? []} change={change} />
        <label>
          <input
            type="checkbox"
            name="adjustSalary"
            checked={draft.adjustSalary}
            onChange={(event) => change({ adjustSalary: event.target.checked })}
          />
          {linkageText.adjustSalary}
        </label>
        {draft.adjustSalary && <p>{linkageText.salaryHint}</p>}
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
        <label>
          {linkageText.trialStartDate}
          <input
            name="onTrialStartDate"
            type="date"
            value={draft.onTrialStartDate}
            onChange={(event) => change({ onTrialStartDate: event.target.value })}
          />
        </label>
        <PersonSelect
          name="handoverPersonId"
          label={linkageText.handoverPerson}
          value={draft.handoverPersonId}
          people={people}
          onChange={(handoverPersonId) => change({ handoverPersonId })}
        />
      </div>
      <DutyFields draft={draft} people={people} change={change} />
    </fieldset>
  );
}

function ContractFields(props: {
  draft: LinkageDraft;
  contracts: readonly Choice[];
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
              {contracts.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.name}
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
