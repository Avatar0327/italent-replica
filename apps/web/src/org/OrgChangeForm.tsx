import { text } from './messages.js';
import type { Organization, ChangeModel } from './types.js';
export type { Organization, ChangeModel } from './types.js';
/** 按可见字段决定可编辑项：详情里没有返回的字段不显示、不提交（S1-P2-05）。 */
export function editableFields(original: Organization) {
  return {
    name: typeof original.name === 'string',
    parent: original.parents?.admin !== undefined,
    remarks: original.remarks !== undefined,
  };
}
export function needsEmploymentChoice(original: Organization, model: ChangeModel) {
  const editable = editableFields(original);
  return (
    (editable.name && model.name.trim() !== original.name) ||
    (editable.parent && model.parentId !== (original.parents?.admin?.parentId ?? ''))
  );
}
export function changeInput(original: Organization, model: ChangeModel, effectiveDate: string) {
  const editable = editableFields(original);
  return {
    effectiveDate,
    ...(editable.name && model.name.trim() !== original.name ? { name: model.name.trim() } : {}),
    ...(editable.parent && model.parentId !== (original.parents?.admin?.parentId ?? '')
      ? { parents: { admin: { parentId: model.parentId, sequence: original.parents?.admin?.sequence ?? null } } }
      : {}),
    ...(editable.remarks && model.remarks !== (original.remarks ?? '') ? { remarks: model.remarks } : {}),
    ...(needsEmploymentChoice(original, model) ? { addEmployment: model.addEmployment === 'yes' } : {}),
  };
}
export function OrgChangeForm(props: {
  original: Organization;
  model: ChangeModel;
  parents: Organization[];
  busy: boolean;
  onChange: (model: ChangeModel) => void;
  onSave: () => void;
}) {
  const { model, original, onChange } = props;
  const editable = editableFields(original);
  const choose = needsEmploymentChoice(original, model);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <fieldset disabled={props.busy}>
        {editable.name && (
          <label>
            {text.name}
            <input
              required
              maxLength={200}
              value={model.name}
              onChange={(event) => onChange({ ...model, name: event.target.value, addEmployment: '' })}
            />
          </label>
        )}
        {editable.parent && (
          <label>
            {text.parent}
            <select
              required
              value={model.parentId}
              onChange={(event) => onChange({ ...model, parentId: event.target.value, addEmployment: '' })}
            >
              <option value="">{text.select}</option>
              {props.parents
                .filter((org) => org.id !== original.id)
                .map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name ?? text.hiddenParent}
                  </option>
                ))}
            </select>
          </label>
        )}
        {editable.remarks && (
          <label>
            {text.remarks}
            <textarea
              value={model.remarks}
              maxLength={4000}
              onChange={(event) => onChange({ ...model, remarks: event.target.value })}
            />
          </label>
        )}
        {choose && <EmploymentChoice model={model} onChange={onChange} />}
        <button type="submit">{props.busy ? text.saving : text.save}</button>
      </fieldset>
    </form>
  );
}
/** 改名 / 改行政上级时必填的“是否新增任职”（DEC-137）。 */
function EmploymentChoice(props: { model: ChangeModel; onChange: (model: ChangeModel) => void }) {
  const { model, onChange } = props;
  return (
    <label>
      {text.choice}
      <select
        required
        name="addEmployment"
        value={model.addEmployment}
        onChange={(event) => onChange({ ...model, addEmployment: event.target.value as ChangeModel['addEmployment'] })}
      >
        <option value="">{text.select}</option>
        <option value="yes">{text.yes}</option>
        <option value="no">{text.no}</option>
      </select>
    </label>
  );
}
