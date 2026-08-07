export interface BarChartBar {
  label: string;
  value: number;
}

interface BarChartProps {
  bars: BarChartBar[];
  color?: string;
  height?: number;
}

// Hand-rolled SVG bar chart — mirrors LineChart.tsx's structure/padding, matching this project's
// minimal-dependency convention (see CLAUDE.md, "Website implementation notes"). Purely
// presentational: takes already-binned bars, plots them on a 0..max y-axis.
export default function BarChart({ bars, color = "#ff8238", height = 260 }: BarChartProps) {
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
  const barWidth = Math.max(1, slotWidth * 0.7);

  function yFor(value: number): number {
    return paddingTop + plotHeight - (value / maxValue) * plotHeight;
  }

  const yGridLines = 4;
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
              <rect x={barX} y={y} width={barWidth} height={barHeight} fill={color} rx={2} />
              <text x={slotX + slotWidth / 2} y={height - paddingBottom + 14} textAnchor="middle" className="fill-muted text-[9px]">
                {bar.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
