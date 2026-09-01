export interface BarChartBar {
  label: string;
  value: number;
  color?: string;
}

interface BarChartProps {
  bars: BarChartBar[];
  color?: string;
  height?: number;
  // Bars fill their whole slot with no gap between neighbors, instead of the default centered
  // bar with breathing room either side — used by MMRDistributionPanel's density slider, where a
  // higher bar count should read as a continuous histogram rather than a bar-code of thin bars.
  connected?: boolean;
  // Caps how many x-axis labels are drawn, evenly spaced by index, instead of one per bar —
  // needed once density pushes barCount well past what 800px can legibly print. Omit to label
  // every bar (unchanged default, e.g. SeriesLengthPanel's fixed 3 bars).
  maxLabels?: number;
}

// Hand-rolled SVG bar chart — mirrors LineChart.tsx's structure/padding, matching this project's
// minimal-dependency convention (see CLAUDE.md, "Website implementation notes"). Purely
// presentational: takes already-binned bars, plots them on a 0..max y-axis.
export default function BarChart({ bars, color = "#ff8238", height = 260, connected = false, maxLabels }: BarChartProps) {
  const width = 800;
  const paddingLeft = 40;
  const paddingRight = 12;
  const paddingTop = 12;
  const paddingBottom = 32;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const maxValue = Math.max(1, ...bars.map((b) => b.value));
  const barCount = bars.length;
  const slotWidth = barCount > 0 ? plotWidth / barCount : plotWidth;
  const barWidth = connected ? slotWidth : Math.max(1, slotWidth * 0.7);
  // Evenly-spaced-by-index subsample, e.g. every 5th bar at barCount=50, maxLabels=10 — not
  // trying to land exactly on the first/last bar, just keeping the label density constant as
  // barCount grows.
  const labelEvery = maxLabels && barCount > maxLabels ? Math.ceil(barCount / maxLabels) : 1;

  function yFor(value: number): number {
    return paddingTop + plotHeight - (value / maxValue) * plotHeight;
  }

  // Fewer than 4 gridlines once the tallest bar is itself below 4, so the rounded labels stay
  // distinct: at maxValue=3 a fixed 4 would tick 0,1,2,2,3 — a repeated label drawn over itself,
  // and a duplicate React key. Capping the count at floor(maxValue) keeps the step at >=1, which
  // is what guarantees uniqueness (a sub-1 step is the only way two ticks can round together).
  // Floor because bars may carry fractional values (SeriesLengthPanel plots percentages).
  const yGridLines = Math.max(1, Math.min(4, Math.floor(maxValue)));
  const yTicks = Array.from({ length: yGridLines + 1 }, (_, i) => Math.round((maxValue / yGridLines) * i));

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Bar chart">
        {yTicks.map((tick) => {
          const y = yFor(tick);
          return (
            <g key={tick}>
              <line x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} stroke="currentColor" className="text-foreground/10" strokeWidth={1} />
              <text x={paddingLeft - 6} y={y + 3} textAnchor="end" className="fill-muted text-[9px]">
                {tick}
              </text>
            </g>
          );
        })}

        {bars.map((bar, i) => {
          const slotX = paddingLeft + i * slotWidth;
          const barX = slotX + (slotWidth - barWidth) / 2;
          const y = yFor(bar.value);
          const barHeight = paddingTop + plotHeight - y;
          return (
            <g key={i}>
              <rect x={barX} y={y} width={barWidth} height={barHeight} fill={bar.color ?? color} rx={connected ? 0 : 2} />
              {i % labelEvery === 0 && (
                <text x={slotX + slotWidth / 2} y={height - paddingBottom + 14} textAnchor="middle" className="fill-muted text-[9px]">
                  {bar.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
