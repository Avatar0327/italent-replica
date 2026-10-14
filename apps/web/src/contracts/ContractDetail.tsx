import { Button, Descriptions, Space } from 'antd';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { m } from './messages.js';
import { contractApi, object, value, type Row } from './model.js';
import { useRead } from './useRead.js';
import { ContractButtons } from './ContractForm.js';
import { sourceOperations } from './forms.js';
import { employmentItems, employmentOf } from './parts.js';
import { NameOf, RefLabel, refPaths, useToday } from './references.js';

// 原站详情的合同信息字段与顺序（DEC-489）；终止日期、原合同、版本号、状态、审批状态原站不展示。
const contractKeys = [
  'employeeId',
  'number',
  'companyId',
  'typeId',
  'termType',
  'signingDate',
  'effectiveDate',
  'actualTerminationDate',
  'signingCount',
];
function cell(row: Row, key: string) {
  if (key === 'employeeId') return <NameOf path={refPaths.employeeId} id={row.employeeId} />;
  if (key === 'typeId') return <RefLabel path={refPaths.typeId} id={row.typeId} />;
  if (key === 'companyId') return <RefLabel path={refPaths.companyId} id={row.companyId} />;
  return value(row[key], key);
}

export function ContractDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const result = useRead<Row>(id ? `${contractApi.records}/${encodeURIComponent(id)}` : null);
  const data = result.data;
  // 原站详情标题是入职日期；没有可查看的任职摘要时退回通用标题。
  const entryDate = employmentOf(data)?.entryDate;
  return (
    <div className="contract-detail">
      <header className="contract-heading">
        <h1>{typeof entryDate === 'string' && entryDate ? entryDate : m.detail}</h1>
        <Space>
          <Button onClick={() => navigate(`/contracts?view=${params.get('view') ?? 'all'}`)}>{m.back}</Button>
          {/* 三种入口各按自己的状态规则（CT-R3）；拒绝口径仍以后端为准。 */}
          {data && <ContractButtons ops={sourceOperations(data)} source={data} onDone={result.refresh} />}
        </Space>
      </header>
      {!!result.error && <PageState kind="error" error={result.error} retry={result.refresh} />}
      {!result.error && result.loading && <PageState kind="loading" />}
      {!result.error && !result.loading && data && <Agreement data={data} />}
    </div>
  );
}
/** 原站详情只有一个可收起的“合同协议”分区：先任职信息，再合同信息；没有版本链 / 历史入口。 */
function Agreement({ data }: { data: Row }) {
  const permission = usePermissions(object);
  const allowed = permission.snapshot.objects[object]?.viewableFields ?? [];
  // 任职名称按今天（租户时区）解析：详情展示的是当前任职，不是合同签订时的任职。
  const asOf = useToday();
  const employment = employmentOf(data);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="contract-card">
      <div className="contract-section-title">
        <h2>{m.agreement}</h2>
        <Button type="link" size="small" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? m.expand : m.collapse}
        </Button>
      </div>
      {!collapsed && (
        <>
          <h3>{m.employment}</h3>
          {employment ? (
            <Descriptions column={2} size="small" items={employmentItems(employment, asOf)} />
          ) : (
            <p>{m.noEmployment}</p>
          )}
          <h3>{m.contract}</h3>
          <Descriptions
            className="contract-info"
            column={2}
            size="small"
            items={contractKeys
              .filter((key) => allowed.includes(key))
              .map((key) => ({ key, label: m.fields[key] ?? key, children: cell(data, key) }))}
          />
        </>
      )}
    </section>
  );
}
