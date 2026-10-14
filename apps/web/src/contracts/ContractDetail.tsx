import { Button } from 'antd';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { employmentExample, historyExample } from '../demo-stubs/contracts.js';
import { m } from './messages.js';
import { object, type Row } from './model.js';
import { useRead } from './useRead.js';
import { Coming, DemoNote, Fields } from './parts.js';
export function ContractDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const permission = usePermissions(object);
  const result = useRead<Row>(id ? `/api/tenant/contracts/records/${encodeURIComponent(id)}` : null);
  return (
    <div className="contract-detail">
      <header className="contract-heading">
        <h1>{m.detail}</h1>
        <Button onClick={() => navigate(`/contracts?view=${params.get('view') ?? 'all'}`)}>{m.back}</Button>
        <Coming labels={[m.edit, m.change, m.renew, m.terminate]} />
      </header>
      {!!result.error && <PageState kind="error" error={result.error} retry={result.refresh} />}
      {!result.error && result.loading && <PageState kind="loading" />}
      {!result.error && !result.loading && (
        <>
          <section className="contract-card">
            <h2>{m.contract}</h2>
            <Fields
              row={result.data ?? {}}
              allowed={permission.snapshot.objects[object]?.viewableFields ?? []}
              keys={[
                'employeeId',
                'number',
                'companyId',
                'typeId',
                'termType',
                'signingDate',
                'effectiveDate',
                'endDate',
                'actualTerminationDate',
                'signingCount',
                'rootContractId',
                'versionNo',
                'status',
                'approvalStatus',
              ]}
            />
          </section>
          <section className="contract-card">
            <DemoNote detail={m.employmentHint} />
            <h2>{m.employment}</h2>
            <Fields row={employmentExample} keys={Object.keys(employmentExample)} />
            <h2>{m.history}</h2>
            <ol>
              {historyExample.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
