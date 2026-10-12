import { TalentMaintenance } from './TalentMaintenance.js';
import { m } from './catalog/messages.js';
import { CatalogModule } from './catalog/CatalogModule.js';
import { talentResources } from './catalog/resources.js';
export function TalentPage() {
  return (
    <CatalogModule
      resources={talentResources}
      extra={{
        key: 'maintenance',
        title: m.maintenance,
        object: 'TalentCenter.DimensionLibrary',
        content: <TalentMaintenance />,
      }}
    />
  );
}
