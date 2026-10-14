import { Button, Descriptions, Space } from 'antd';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { m } from './messages.js';
import { contractApi, object, value, type Row } from './model.js';
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
  const result = useRead<Row>(id ? `${contractApi.records}/${encodeURIComponent(id)}` : null);
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
        // 原站详情只有一个“合同协议”分区：先任职信息，再合同信息；没有版本链 / 历史入口。
        <section className="contract-card">
          <h2>{m.agreement}</h2>
          <Employment data={data} />
          <h3>{m.contract}</h3>
          <Descriptions
            column={2}
            size="small"
            items={contractKeys
              .filter((key) => allowed.includes(key))
              .map((key) => ({ key, label: m.fields[key] ?? key, children: cell(data, key) }))}
          />
        </section>
      )}
    </div>
  );
}
/** 任职摘要来自详情接口（按任职对象字段裁剪）；字段按原站六项，机构 / 直线经理 / 虚线经理后端未提供显示“--”。 */
function Employment({ data }: { data: Row }) {
  // 任职名称按今天（租户时区）解析：详情展示的是当前任职，不是合同签订时的任职。
  const asOf = useToday();
  const employment = data.employment && typeof data.employment === 'object' ? (data.employment as Row) : undefined;
  const missing = '--';
  return (
    <>
      <h3>{m.employment}</h3>
      {!employment ? (
        <p>{m.noEmployment}</p>
      ) : (
        <Descriptions
          column={2}
          size="small"
          items={[
            { key: 'entryDate', label: m.fields.entryDate, children: value(employment.entryDate, 'entryDate') },
            { key: 'organization', label: m.fields.organization, children: missing },
            {
              key: 'department',
              label: m.fields.department,
              children: <NameOf path={refPaths.departmentId} id={employment.departmentId} asOf={asOf} />,
            },
            { key: 'job', label: m.fields.job, children: <NameOf path={refPaths.postId} id={employment.postId} /> },
            { key: 'manager', label: m.fields.manager, children: missing },
            { key: 'dottedManager', label: m.fields.dottedManager, children: missing },
          ]}
        />
      )}
    </>
  );
}
