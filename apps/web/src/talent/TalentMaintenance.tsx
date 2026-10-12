import { Tabs } from 'antd';
import { useRef } from 'react';
import { useSession } from '../foundation/Session.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { CategoryPanel } from './CategoryPanel.js';
import { CriterionPanel } from './CriterionPanel.js';
import { DescriptionTypePanel } from './DescriptionTypePanel.js';
import { DimensionCategoryPanel } from './DimensionCategoryPanel.js';
import { DimensionPanel } from './DimensionPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { text } from './messages.js';
import { m } from './catalog/messages.js';
import type { ModelImageCommand } from './model-image-api.js';
import { TalentTenantContext } from './TalentTenantContext.js';

/** 保留已有完整维护能力，避免页面换版丢失分类、模型图和各类子表编辑。 */
export function TalentMaintenance() {
  const { tenantId } = useSession();
  const commands = useRef(new Map<string, ModelImageCommand>());
  return (
    <div className="catalog-page catalog-maintenance">
      <DecisionNote id="talent-maintenance" />
      <h1>{m.maintenance}</h1>
      <TalentTenantContext.Provider value={{ tenantId, modelImageCommands: commands.current }}>
        <Tabs
          destroyOnHidden
          items={[
            { key: 'libraries', label: text.tabs.libraries, children: <LibraryPanel tenantId={tenantId} /> },
            { key: 'dimensions', label: text.tabs.dimensions, children: <DimensionPanel tenantId={tenantId} /> },
            { key: 'criteria', label: text.tabs.criteria, children: <CriterionPanel tenantId={tenantId} /> },
            { key: 'categories', label: text.tabs.categories, children: <CategoryPanel tenantId={tenantId} /> },
            {
              key: 'dimensionCategories',
              label: text.tabs.dimensionCategories,
              children: <DimensionCategoryPanel tenantId={tenantId} />,
            },
            {
              key: 'descriptionTypes',
              label: text.tabs.descriptionTypes,
              children: <DescriptionTypePanel tenantId={tenantId} />,
            },
          ]}
        />
      </TalentTenantContext.Provider>
    </div>
  );
}
