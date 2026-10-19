import { DecisionNote } from '../foundation/DecisionNote.js';
import { DirectCommands } from './direct-commands.js';
import { PartTimeList } from './PartTimeList.js';
import './part-time.css';
export function PartTimePage() {
  return (
    <div className="part-time-page">
      <DecisionNote id="part-time" />
      <DirectCommands>
        <PartTimeList />
      </DirectCommands>
    </div>
  );
}
