import { text } from './messages.js';
import type { Organization, ChangeModel } from './types.js';
export type { Organization, ChangeModel } from './types.js';
export function needsEmploymentChoice(original: Organization, model: ChangeModel) {
  return model.name.trim() !== original.name || model.parentId !== original.parents.admin?.parentId;
}
export function changeInput(original: Organization, model: ChangeModel, effectiveDate: string) {
  return {
    effectiveDate,
    ...(model.name.trim() !== original.name ? { name: model.name.trim() } : {}),
    ...(model.parentId !== original.parents.admin?.parentId
      ? { parents: { admin: { parentId: model.parentId, sequence: original.parents.admin?.sequence ?? null } } }
      : {}),
    ...(model.remarks !== (original.remarks ?? '') ? { remarks: model.remarks } : {}),
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
  const choose = needsEmploymentChoice(original, model);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <fieldset disabled={props.busy}>
        <label>
          {text.name}
          <input
            required
            maxLength={200}
            value={model.name}
            onChange={(event) => onChange({ ...model, name: event.target.value, addEmployment: '' })}
          />
        </label>
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
                  {org.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {text.remarks}
          <textarea
            value={model.remarks}
            maxLength={4000}
            onChange={(event) => onChange({ ...model, remarks: event.target.value })}
          />
        </label>
        {choose && (
          <label>
            {text.choice}
            <select
              required
              name="addEmployment"
              value={model.addEmployment}
              onChange={(event) =>
                onChange({ ...model, addEmployment: event.target.value as ChangeModel['addEmployment'] })
              }
            >
              <option value="">{text.select}</option>
              <option value="yes">{text.yes}</option>
              <option value="no">{text.no}</option>
            </select>
          </label>
        )}
        <button type="submit">{props.busy ? text.saving : text.save}</button>
      </fieldset>
    </form>
  );
}
