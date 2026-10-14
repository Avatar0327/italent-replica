import { Link, Route, Routes, useLocation } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { configObjects, type Config } from './model.js';
import { ContractList } from './ContractList.js';
import { ContractDetail } from './ContractDetail.js';
import { ContractConfig } from './ContractConfig.js';
import { m } from './messages.js';
import './contracts.css';
export function ContractsPage() {
  const location = useLocation();
  const types = usePermissions(configObjects.types);
  const rules = usePermissions(configObjects.rules);
  const settings = usePermissions(configObjects.settings);
  const access = { types, rules, settings };
  // 命令存储在模块级（commands.ts），不放页面根部：AppPages 按 pathname 重建页面，切子页会连同存储一起销毁。
  return (
    <div className="contracts-page">
      <nav className="contract-toolbar" aria-label={m.settings}>
        <Link to="/contracts">{m.title}</Link>
        {(Object.keys(configObjects) as Config[])
          .filter((kind) => access[kind].snapshot.objects[configObjects[kind]])
          .map((kind) => (
            <Link key={kind} to={`/contracts/${kind}`}>
              {m[kind]}
            </Link>
          ))}
      </nav>
      <DecisionNote id="contracts" />
      <Routes>
        <Route index element={<ContractList key={location.search} />} />
        <Route path="records/:id" element={<ContractDetail key={location.pathname} />} />
        {(Object.keys(configObjects) as Config[]).map((kind) => (
          <Route
            key={kind}
            path={kind}
            element={
              access[kind].snapshot.objects[configObjects[kind]] ? (
                <ContractConfig key={kind} kind={kind} />
              ) : (
                <PageState kind="forbidden" />
              )
            }
          />
        ))}
        <Route path="*" element={<PageState kind="not-found" />} />
      </Routes>
    </div>
  );
}
