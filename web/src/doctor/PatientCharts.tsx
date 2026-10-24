/**
 * Patient-detail charts (Req 22.3, 22.4, 22.5). English only.
 *
 * Every SVG plot is `aria-hidden`; a table (visually hidden, except the
 * supplements history which is shown) carries the same data for assistive
 * technologies and keyboard users.
 */
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MotherOut, VisitOut } from '../shared/types';
import {
  BP_DIASTOLIC_LINES,
  BP_SYSTOLIC_LINES,
  HB_REFERENCE_LINES,
  bpSeries,
  hbSeries,
  paddedDomain,
  supplementSeries,
  weightGainSeries,
} from './patientChartData';
import { REFERENCE_BAND_LABEL } from './weightBand';

const TICK = { fontSize: 12, fill: '#1a1a1a' };
const GRID = '#d0d0d0';
const CHART_HEIGHT = 240;

const fmt1 = (x: number | null | undefined): string => (x == null ? '–' : x.toFixed(1));
const fmt2 = (x: number | null | undefined): string => (x == null ? '–' : x.toFixed(2));

export function WeightGainChart({ mother, visits }: { mother: MotherOut; visits: readonly VisitOut[] }) {
  const series = weightGainSeries(mother, visits);
  const maxWeek = series.points.length > 0 ? series.points[series.points.length - 1].week : 40;

  return (
    <figure className="pd-chart" aria-labelledby="pd-weight-caption">
      <figcaption id="pd-weight-caption">
        <strong>Weight gain since baseline (kg) by gestational week</strong>
        <span className="pd-chart__note">{REFERENCE_BAND_LABEL}</span>
        <span className="pd-chart__note">
          Baseline {series.baselineKg != null ? `${series.baselineKg.toFixed(2)} kg` : 'unknown'}; BMI category{' '}
          {series.category}
          {mother.height_cm == null ? ' (height unknown)' : ''}.
        </span>
      </figcaption>
      {series.visits.length === 0 ? (
        <p className="pd-empty">No weights recorded yet.</p>
      ) : (
        <>
          <div className="pd-chart__plot" aria-hidden="true">
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <ComposedChart data={series.points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="week"
                  domain={[0, maxWeek]}
                  tick={TICK}
                  label={{ value: 'GA (weeks)', position: 'insideBottom', offset: -4, fontSize: 12 }}
                />
                <YAxis tick={TICK} width={44} />
                <Tooltip />
                <Legend verticalAlign="top" height={28} />
                <Area
                  type="monotone"
                  dataKey="band"
                  name={REFERENCE_BAND_LABEL}
                  stroke="#1b6e3a"
                  fill="#cfe8d6"
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="gain"
                  name="Actual gain (kg)"
                  stroke="#7a1f5c"
                  strokeWidth={3}
                  dot={{ r: 4, fill: '#7a1f5c' }}
                  connectNulls
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <table className="visually-hidden">
            <caption>Weight gain against the reference band</caption>
            <thead>
              <tr>
                <th scope="col">Visit date</th>
                <th scope="col">GA (weeks)</th>
                <th scope="col">Weight (kg)</th>
                <th scope="col">Gain (kg)</th>
                <th scope="col">Band low (kg)</th>
                <th scope="col">Band high (kg)</th>
              </tr>
            </thead>
            <tbody>
              {series.visits.map((p, i) => (
                <tr key={`${p.date}-${i}`}>
                  <td>{p.date}</td>
                  <td>{fmt1(p.week)}</td>
                  <td>{fmt2(p.weightKg)}</td>
                  <td>{fmt2(p.gain)}</td>
                  <td>{fmt2(p.band[0])}</td>
                  <td>{fmt2(p.band[1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}

export function HbChart({ visits }: { visits: readonly VisitOut[] }) {
  const data = hbSeries(visits);
  return (
    <figure className="pd-chart" aria-labelledby="pd-hb-caption">
      <figcaption id="pd-hb-caption">
        <strong>Hb history (g/dL)</strong>
        <span className="pd-chart__note">Reference lines at 7 (severe), 10 (moderate) and 11 g/dL (mild).</span>
      </figcaption>
      {data.length === 0 ? (
        <p className="pd-empty">No Hb readings yet.</p>
      ) : (
        <>
          <div className="pd-chart__plot" aria-hidden="true">
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <LineChart data={data} margin={{ top: 8, right: 32, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={TICK} />
                <YAxis
                  domain={paddedDomain(
                    data.map((d) => d.hb),
                    HB_REFERENCE_LINES,
                    1,
                  )}
                  tick={TICK}
                  width={40}
                />
                <Tooltip />
                {HB_REFERENCE_LINES.map((y) => (
                  <ReferenceLine
                    key={y}
                    y={y}
                    stroke={y === 7 ? '#a50e0e' : '#8a6100'}
                    strokeDasharray="4 4"
                    label={{ value: String(y), position: 'right', fontSize: 12, fill: '#1a1a1a' }}
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="hb"
                  name="Hb (g/dL)"
                  stroke="#1a4fd6"
                  strokeWidth={3}
                  dot={{ r: 4, fill: '#1a4fd6' }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <table className="visually-hidden">
            <caption>Hb history</caption>
            <thead>
              <tr>
                <th scope="col">Visit date</th>
                <th scope="col">Hb (g/dL)</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td>{fmt1(d.hb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}

export function BpChart({ visits }: { visits: readonly VisitOut[] }) {
  const data = bpSeries(visits);
  return (
    <figure className="pd-chart" aria-labelledby="pd-bp-caption">
      <figcaption id="pd-bp-caption">
        <strong>BP history (mmHg)</strong>
        <span className="pd-chart__note">Reference lines at 140/90 (high) and 160/110 (severe).</span>
      </figcaption>
      {data.length === 0 ? (
        <p className="pd-empty">No BP readings yet.</p>
      ) : (
        <>
          <div className="pd-chart__plot" aria-hidden="true">
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <LineChart data={data} margin={{ top: 8, right: 32, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={TICK} />
                <YAxis
                  domain={paddedDomain(
                    data.flatMap((d) => [d.systolic, d.diastolic]),
                    [...BP_SYSTOLIC_LINES, ...BP_DIASTOLIC_LINES],
                    10,
                  )}
                  tick={TICK}
                  width={44}
                />
                <Tooltip />
                <Legend verticalAlign="top" height={28} />
                {BP_SYSTOLIC_LINES.map((y) => (
                  <ReferenceLine
                    key={`s${y}`}
                    y={y}
                    stroke={y === 160 ? '#a50e0e' : '#8a6100'}
                    strokeDasharray="4 4"
                    label={{ value: `${y}`, position: 'right', fontSize: 12, fill: '#1a1a1a' }}
                  />
                ))}
                {BP_DIASTOLIC_LINES.map((y) => (
                  <ReferenceLine
                    key={`d${y}`}
                    y={y}
                    stroke={y === 110 ? '#a50e0e' : '#8a6100'}
                    strokeDasharray="2 6"
                    label={{ value: `${y}`, position: 'right', fontSize: 12, fill: '#1a1a1a' }}
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="systolic"
                  name="Systolic"
                  stroke="#7a1f5c"
                  strokeWidth={3}
                  dot={{ r: 4, fill: '#7a1f5c' }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="diastolic"
                  name="Diastolic"
                  stroke="#1a4fd6"
                  strokeWidth={3}
                  strokeDasharray="6 3"
                  dot={{ r: 4, fill: '#1a4fd6' }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <table className="visually-hidden">
            <caption>BP history</caption>
            <thead>
              <tr>
                <th scope="col">Visit date</th>
                <th scope="col">Systolic (mmHg)</th>
                <th scope="col">Diastolic (mmHg)</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td>{d.systolic}</td>
                  <td>{d.diastolic}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}

export function SupplementsChart({ visits }: { visits: readonly VisitOut[] }) {
  const data = supplementSeries(visits);
  return (
    <figure className="pd-chart" aria-labelledby="pd-supp-caption">
      <figcaption id="pd-supp-caption">
        <strong>Supplements per visit</strong>
        <span className="pd-chart__note">IFA and calcium tablets given; ★ marks take-home ration (THR) received.</span>
      </figcaption>
      {data.length === 0 ? (
        <p className="pd-empty">No supplements recorded yet.</p>
      ) : (
        <>
          <div className="pd-chart__plot" aria-hidden="true">
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={TICK} />
                <YAxis tick={TICK} width={40} allowDecimals={false} />
                <Tooltip />
                <Legend verticalAlign="top" height={28} />
                <Bar dataKey="ifa" name="IFA tablets" fill="#7a1f5c" isAnimationActive={false} />
                <Bar dataKey="calcium" name="Calcium tablets" fill="#1a4fd6" isAnimationActive={false} />
                <Scatter dataKey="thrMarker" name="THR received" fill="#1b6e3a" shape="star" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <table className="pd-table">
            <caption>Supplements history</caption>
            <thead>
              <tr>
                <th scope="col">Visit date</th>
                <th scope="col">IFA tablets</th>
                <th scope="col">Calcium tablets</th>
                <th scope="col">THR received</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td>{d.ifa ?? '–'}</td>
                  <td>{d.calcium ?? '–'}</td>
                  <td>{d.thr == null ? '–' : d.thr ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}
