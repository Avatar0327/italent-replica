import { CatalogModule } from '../talent/catalog/CatalogModule.js';
import { qualificationResources } from './resources.js';
import { DevelopmentChannel } from './DevelopmentChannel.js';
import { q } from './messages.js';
export function QualificationPage() {
  return (
    <CatalogModule
      resources={qualificationResources}
      extra={{
        key: 'channels',
        title: q.channels,
        objects: ['Qualification.DevelopmentChannel'],
        content: <DevelopmentChannel />,
      }}
    />
  );
}
