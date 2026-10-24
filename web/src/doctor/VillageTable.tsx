/**
 * Village census table (Req 20.3): a semantic table with a caption and the columns
 * village, pregnant, BPL, red, amber, green and due this month. It is also the
 * accessible equivalent of the map.
 *
 * Clicking a row (or its village button, for keyboard users) selects that village
 * as the queue filter; selecting it again clears the filter. The village button
 * carries `aria-pressed`, so the current filter is announced.
 */
import type { CensusVillageOut } from '../shared/types';
import { villageTotals } from './census';

export interface VillageTableProps {
  villages: readonly CensusVillageOut[];
  /** Currently selected village filter, or null for all villages. */
  selectedVillageId: string | null;
  onSelectVillage: (villageId: string | null) => void;
}

export function VillageTable({ villages, selectedVillageId, onSelectVillage }: VillageTableProps) {
  const totals = villageTotals(villages);
  const toggle = (id: string) => onSelectVillage(selectedVillageId === id ? null : id);
  const selected = villages.find((v) => v.id === selectedVillageId) ?? null;

  return (
    <div className="village-table">
      <table>
        <caption>
          Pregnant women by village. Select a village to filter the triage queue.
          {selected ? <span className="village-table__filter"> Filtered: {selected.name}.</span> : null}
        </caption>
        <thead>
          <tr>
            <th scope="col">Village</th>
            <th scope="col">Pregnant</th>
            <th scope="col">BPL</th>
            <th scope="col">Red</th>
            <th scope="col">Amber</th>
            <th scope="col">Green</th>
            <th scope="col">Due this month</th>
          </tr>
        </thead>
        <tbody>
          {villages.map((v) => {
            const isSelected = v.id === selectedVillageId;
            return (
              <tr
                key={v.id}
                className={isSelected ? 'village-table__row is-selected' : 'village-table__row'}
                onClick={() => toggle(v.id)}
              >
                <th scope="row">
                  <button
                    type="button"
                    className="village-table__select"
                    aria-pressed={isSelected}
                    onClick={(e) => {
                      // The row handler would toggle a second time.
                      e.stopPropagation();
                      toggle(v.id);
                    }}
                  >
                    {v.name}
                  </button>
                </th>
                <td>{v.pregnant}</td>
                <td>{v.bpl}</td>
                <td>{v.red}</td>
                <td>{v.amber}</td>
                <td>{v.green}</td>
                <td>{v.due_this_month}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All villages</th>
            <td>{totals.pregnant}</td>
            <td>{totals.bpl}</td>
            <td>{totals.red}</td>
            <td>{totals.amber}</td>
            <td>{totals.green}</td>
            <td>{totals.due_this_month}</td>
          </tr>
        </tfoot>
      </table>
      {selected ? (
        <button type="button" className="btn village-table__clear" onClick={() => onSelectVillage(null)}>
          Show all villages
        </button>
      ) : null}
    </div>
  );
}

export default VillageTable;
