/**
 * Village map (Req 20.4, 20.5).
 *
 * - react-leaflet map with the attributed OpenStreetMap tile layer. The census has
 *   no facility coordinates, so the view is framed on the facility's villages.
 * - One `CircleMarker` per village, radius `6 + 3·√pregnant`, filled with the
 *   village's worst risk color, with a tooltip of counts. Clicking a marker selects
 *   that village as the queue filter, like the table.
 * - On `tileerror` an overlay "Map tiles unavailable offline – see table" appears;
 *   markers keep rendering (they are vectors, not tiles).
 * - The village table is the accessible equivalent: keyboard panning is off so the
 *   map adds no tab stop before the queue (Req 38.4), and the figure carries a
 *   text summary for screen readers.
 */
import 'leaflet/dist/leaflet.css';
import { useMemo, useState } from 'react';
import { CircleMarker, MapContainer, TileLayer, Tooltip } from 'react-leaflet';
import { RISK_PALETTE } from '../shared/RiskChip';
import type { CensusVillageOut } from '../shared/types';
import { DEFAULT_MAP_CENTER, markerRadius, villageBounds, villageSummary, villageWorstRisk } from './census';

export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
export const TILES_OFFLINE_TEXT = 'Map tiles unavailable offline – see table';

/** Fill for a village with no active mothers. */
const EMPTY_FILL = '#8a8a8a';

export interface VillageMapProps {
  villages: readonly CensusVillageOut[];
  selectedVillageId: string | null;
  onSelectVillage: (villageId: string | null) => void;
}

export function VillageMap({ villages, selectedVillageId, onSelectVillage }: VillageMapProps) {
  const [tilesFailed, setTilesFailed] = useState(false);
  const bounds = useMemo(() => villageBounds(villages), [villages]);
  const located = villages.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
  const summary = `Map of ${located.length} villages. Circle size shows the number of pregnant women; color shows the worst risk. The village table has the same data.`;

  const tileHandlers = useMemo(() => ({ tileerror: () => setTilesFailed(true) }), []);

  return (
    <figure className="village-map">
      <div className="village-map__frame">
        <MapContainer
          className="village-map__map"
          {...(bounds
            ? { bounds, boundsOptions: { padding: [24, 24] as [number, number], maxZoom: 13 } }
            : { center: DEFAULT_MAP_CENTER, zoom: 11 })}
          keyboard={false}
          scrollWheelZoom={false}
        >
          <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} eventHandlers={tileHandlers} />
          {located.map((v) => {
            const risk = villageWorstRisk(v);
            const fill = risk ? RISK_PALETTE[risk].background : EMPTY_FILL;
            const selected = v.id === selectedVillageId;
            return (
              <CircleMarker
                key={v.id}
                center={[v.lat, v.lng]}
                radius={markerRadius(v.pregnant)}
                pathOptions={{
                  color: selected ? '#1a4fd6' : '#1a1a1a',
                  weight: selected ? 4 : 2,
                  fillColor: fill,
                  fillOpacity: 0.75,
                }}
                eventHandlers={{
                  click: () => onSelectVillage(selected ? null : v.id),
                }}
              >
                <Tooltip>
                  <strong>{v.name}</strong>
                  <br />
                  {v.pregnant} pregnant · {v.bpl} BPL
                  <br />
                  RED {v.red} · AMBER {v.amber} · GREEN {v.green}
                  <br />
                  {v.due_this_month} due this month
                </Tooltip>
              </CircleMarker>
            );
          })}
        </MapContainer>
        {tilesFailed ? (
          <p className="village-map__offline" role="status">
            {TILES_OFFLINE_TEXT}
          </p>
        ) : null}
      </div>
      <figcaption className="visually-hidden">
        {summary} {located.map((v) => villageSummary(v)).join('; ')}
      </figcaption>
    </figure>
  );
}

export default VillageMap;
