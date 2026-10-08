import { useRef, useState } from 'react';
import { initialTenantId } from '../demo/tenant.js';
import { CategoryPanel } from './CategoryPanel.js';
import { CriterionPanel } from './CriterionPanel.js';
import { DescriptionTypePanel } from './DescriptionTypePanel.js';
import { DimensionCategoryPanel } from './DimensionCategoryPanel.js';
import { DimensionPanel } from './DimensionPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { text } from './messages.js';
import type { ModelImageCommand } from './model-image-api.js';
import { TalentTenantContext } from './TalentTenantContext.js';

type Tab = keyof typeof text.tabs;
const TABS: readonly Tab[] = [
  'libraries',
  'dimensionCategories',
  'descriptionTypes',
  'dimensions',
  'categories',
  'criteria',
];

/** 人才标准管理端（R3-T01）：指标库、指标库分类、发展建议类型、指标、人才标准分类、人才标准。 */
export function TalentPage() {
  const [tenant, setTenant] = useState(initialTenantId);
  const [active, setActive] = useState(initialTenantId);
  const [tab, setTab] = useState<Tab>('libraries');
  const modelImageCommands = useRef(new Map<string, ModelImageCommand>());
  return (
    <main>
      <h1>{text.title}</h1>
      {active ? (
        <>
          <nav>
            {TABS.map((item) => (
              <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>
                {text.tabs[item]}
              </button>
            ))}
          </nav>
          {tab === 'libraries' && <LibraryPanel key={active} tenantId={active} />}
          {tab === 'dimensionCategories' && <DimensionCategoryPanel key={active} tenantId={active} />}
          {tab === 'descriptionTypes' && <DescriptionTypePanel key={active} tenantId={active} />}
          {tab === 'dimensions' && <DimensionPanel key={active} tenantId={active} />}
          {tab === 'categories' && <CategoryPanel key={active} tenantId={active} />}
          {tab === 'criteria' && (
            <TalentTenantContext.Provider value={{ tenantId: active, modelImageCommands: modelImageCommands.current }}>
              <CriterionPanel key={active} tenantId={active} />
            </TalentTenantContext.Provider>
          )}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setActive(tenant.trim());
          }}
        >
          <label>
            {text.tenant}
            <input required value={tenant} onChange={(event) => setTenant(event.target.value)} />
          </label>
          <button>{text.enter}</button>
        </form>
      )}
    </main>
  );
}
