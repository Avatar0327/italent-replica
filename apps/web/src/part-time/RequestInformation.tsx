import { Descriptions } from 'antd';
import { useInfoReferences, ReferenceError } from '../idp/info-references.js';
import { apiRoot, type Row } from './model.js';
import { Cell } from './references.js';
import { m } from './messages.js';
import { r } from './request-messages.js';
/** 只读分组读当前主职；按 API isCurrent 选，不按浏览器日期或兼职日期推算。 */
export function RequestInformation({ employeeId, request }: { employeeId: unknown; request?: Row }) {
  const id = typeof employeeId === 'string' && employeeId ? encodeURIComponent(employeeId) : undefined;
  const personPath = `/api/tenant/personnel/employees/${id}`;
  const recordsPath = `${apiRoot}/employees/${id}/records`;
  const refs = useInfoReferences(id && !request ? [personPath, recordsPath] : []);
  const person = request?.employee ?? refs.get(personPath);
  const primary = request?.primary ?? (request ? undefined : refs.get(recordsPath));
  return (
    <>
      <ReferenceError refs={refs} />
      <h3>{r.employee}</h3>
      <Descriptions
        column={2}
        size="small"
        items={['name', 'code'].map((key) => ({
          key,
          label: m.fields[key],
          children: String((person as Record<string, unknown> | undefined)?.[key] ?? m.missing),
        }))}
      />
      <h3>{r.primary}</h3>
      <Descriptions
        column={2}
        size="small"
        items={['departmentId', 'directManagerId', 'postId', 'levelId'].map((key) => ({
          key,
          label: m.fields[key],
          children: (
            <Cell
              row={{ id: String(employeeId ?? ''), fields: primary?.fields as Row['fields'] }}
              field={key}
              view="all"
            />
          ),
        }))}
      />
    </>
  );
}
