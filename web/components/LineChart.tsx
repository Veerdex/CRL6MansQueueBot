export interface LineSeries {
  label: string;
  color: string;
  values: number[];
}

interface LineChartProps {
  series: LineSeries[];
  xLabels: string[];
  // Show every Nth x-axis label to avoid crowding — e.g. 4 for a 48-point time-of-day axis.
  xLabelStride?: number;
  height?: number;
}

// Hand-rolled SVG line chart — no charting dependency, matching this project's minimal-dependency
// convention (see CLAUDE.md, "Website implementation notes"). Purely presentational: takes
// already-aggregated series values, plots them on a shared 0..max y-axis.
export default function LineChart({ series, xLabels, xLabelStride = 1, height = 260 }: LineChartProps) {
  const width = 800;
  const paddingLeft = 40;
  const paddingRight = 12;
  const paddingTop = 12;
  const paddingBottom = 32;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const maxValue = Math.max(1, ...series.flatMap((s) => s.values));
  const pointCount = xLabels.length;

  function pointToCoords(index: number, value: number): [number, number] {
    const x = paddingLeft + (pointCount <= 1 ? 0 : (index / (pointCount - 1)) * plotWidth);
    const y = paddingTop + plotHeight - (value / maxValue) * plotHeight;
    return [x, y];
  }

  function pathFor(values: number[]): string {
    return values
      .map((v, i) => {
        const [x, y] = pointToCoords(i, v);
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  const yGridLines = 4;
  const yTicks = Array.from({ length: yGridLines + 1 }, (_, i) => Math.round((maxValue / yGridLines) * i));

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Line chart">
        {yTicks.map((tick) => {
          const [, y] = pointToCoords(0, tick);
          return (
            <g key={tick}>
              <line x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} stroke="currentColor" className="text-foreground/10" strokeWidth={1} />
              <text x={paddingLeft - 6} y={y + 3} textAnchor="end" className="fill-muted text-[9px]">
                {tick}
              </text>
            </g>
          );
        })}

        {xLabels.map((label, i) => {
          if (i % xLabelStride !== 0) return null;
          const [x] = pointToCoords(i, 0);
          return (
            <text key={i} x={x} y={height - paddingBottom + 14} textAnchor="middle" className="fill-muted text-[9px]">
              {label}
            </text>
          );
        })}

        {series.map((s) => (
          <path key={s.label} d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs text-foreground/80">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}
