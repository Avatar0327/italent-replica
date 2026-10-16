import { IdpCommands } from './commands.js';
import { TutorshipList } from './InfoList.js';
import './idp.css';
export function TutorshipPage() {
  return (
    <IdpCommands>
      <div className="idp-page">
        <TutorshipList />
      </div>
    </IdpCommands>
  );
}
