import { Alert, Button, Descriptions, Space, Table } from 'antd';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { m } from './messages.js';
import { object, value, type Row } from './model.js';
import { useRead } from './useRead.js';
import { ContractButtons } from './ContractForm.js';
import { NameOf, RefLabel, refPaths, useToday } from './references.js';

const contractKeys = [
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
];
const versionKeys = [
  'versionNo',
  'number',
  'typeId',
  'termType',
  'effectiveDate',
  'endDate',
  'actualTerminationDate',
  'status',
  'approvalStatus',
];
function cell(row: Row, key: string) {
  if (key === 'typeId') return <RefLabel path={refPaths.typeId} id={row.typeId} />;
  if (key === 'companyId') return <RefLabel path={refPaths.companyId} id={row.companyId} />;
  return value(row[key], key);
}
export function ContractDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const permission = usePermissions(object);
  const allowed = permission.snapshot.objects[object]?.viewableFields ?? [];
  const result = useRead<Row>(id ? `/api/tenant/contracts/records/${encodeURIComponent(id)}` : null);
  const data = result.data;
  return (
    <div className="contract-detail">
      <header className="contract-heading">
        <h1>{m.detail}</h1>
        <Space>
          <Button onClick={() => navigate(`/contracts?view=${params.get('view') ?? 'all'}`)}>{m.back}</Button>
          {/* 变更 / 续签 / 终止只对有效合同开放；其余状态的拒绝口径以后端为准。 */}
          {data?.status === 'valid' && (
            <ContractButtons ops={['change', 'renew', 'terminate']} source={data} onDone={result.refresh} />
          )}
        </Space>
      </header>
      {!!result.error && <PageState kind="error" error={result.error} retry={result.refresh} />}
      {!result.error && result.loading && <PageState kind="loading" />}
      {!result.error && !result.loading && data && (
        <>
          <section className="contract-card">
            <h2>{m.contract}</h2>
            <Descriptions
              column={2}
              size="small"
              items={contractKeys
                .filter((key) => allowed.includes(key))
                .map((key) => ({ key, label: m.fields[key] ?? key, children: cell(data, key) }))}
            />
          </section>
          <Employment data={data} />
          <Versions data={data} />
        </>
      )}
    </div>
  );
}
/** 任职摘要来自详情接口（按任职对象字段裁剪）；名称按业务日向组织 / 职务 / 职位接口解析。 */
function Employment({ data }: { data: Row }) {
  const today = useToday();
  const employment = data.employment && typeof data.employment === 'object' ? (data.employment as Row) : undefined;
  // 任职名称按今天（租户时区）解析：详情展示的是当前任职，不是合同签订时的任职。
  const asOf = today;
  return (
    <section className="contract-card">
      <h2>{m.employment}</h2>
      {!employment ? (
        <p>{m.noEmployment}</p>
      ) : (
        <>
          {asOf && <Alert type="info" showIcon message={m.employmentAsOf(asOf)} />}
          <Descriptions
            column={2}
            size="small"
            items={[
              { key: 'entryDate', label: m.fields.entryDate, children: value(employment.entryDate, 'entryDate') },
              {
                key: 'department',
                label: m.fields.department,
                children: <NameOf path={refPaths.departmentId} id={employment.departmentId} asOf={asOf} />,
              },
              {
                key: 'job',
                label: m.fields.job,
                children: <NameOf path={refPaths.postId} id={employment.postId} />,
              },
              {
                key: 'post',
                label: m.fields.post,
                children: <NameOf path={refPaths.positionId} id={employment.positionId} />,
              },
              { key: 'location', label: m.fields.location, children: value(employment.place, 'place') },
            ]}
          />
        </>
      )}
    </section>
  );
}
function Versions({ data }: { data: Row }) {
  const versions = Array.isArray(data.versions) ? (data.versions as Row[]) : [];
  const permission = usePermissions(object);
  const allowed = permission.snapshot.objects[object]?.viewableFields ?? [];
  return (
    <section className="contract-card">
      <h2>{m.history}</h2>
      <Table<Row>
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        rowKey={(row) => String(row.id)}
        dataSource={versions}
        locale={{ emptyText: m.noVersions }}
        columns={versionKeys
          .filter((key) => allowed.includes(key))
          .map((key) => ({ key, title: m.fields[key] ?? key, render: (_: unknown, row: Row) => cell(row, key) }))}
      />
    </section>
  );
}
