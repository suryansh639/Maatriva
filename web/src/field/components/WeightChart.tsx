/**
 * Field weight trend chart (Req 29.8, 29.9, 29.10).
 *
 * Lazy-loaded by `MotherDetail` (`React.lazy`), so Recharts is fetched only when a
 * mother has at least 2 weights. Below 2 points it renders the empty-state text
 * instead of a chart. The SVG chart is hidden from assistive technologies and a
 * visually hidden table carries the same data (Req 38.1).
 */
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { useI18n } from '../../shared/I18nProvider';

export interface WeightPoint {
  /** "YYYY-MM-DD" */
  date: string;
  weightKg: number;
}

export interface WeightChartProps {
  /** Weights in chronological order. */
  points: readonly WeightPoint[];
}

export function WeightChart({ points }: WeightChartProps) {
  const { t } = useI18n();

  if (points.length < 2) {
    return <p className="weight-chart__empty">{t('field.detail.chartEmpty')}</p>;
  }

  const data = points.map((p) => ({ date: p.date, kg: p.weightKg }));
  const kgs = data.map((d) => d.kg);
  const min = Math.floor(Math.min(...kgs) - 1);
  const max = Math.ceil(Math.max(...kgs) + 1);

  return (
    <figure className="weight-chart" data-testid="weight-chart">
      <div className="weight-chart__plot" aria-hidden="true">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#d0d0d0" strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 12, fill: '#1a1a1a' }} />
            <YAxis
              domain={[min, max]}
              tick={{ fontSize: 12, fill: '#1a1a1a' }}
              width={40}
              allowDecimals={false}
            />
            <Tooltip formatter={(v) => [`${Number(v).toFixed(2)} ${t('field.common.kg')}`, t('field.visit.weight')]} />
            <Line
              type="monotone"
              dataKey="kg"
              stroke="#7a1f5c"
              strokeWidth={3}
              dot={{ r: 4, fill: '#7a1f5c' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="visually-hidden">
        <caption>{t('field.detail.weightChart')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('field.visit.date')}</th>
            <th scope="col">{t('field.visit.weightKg')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.date}-${i}`}>
              <td>{d.date}</td>
              <td>{d.kg.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export default WeightChart;
