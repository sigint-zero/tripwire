/** A stretch where nothing was recorded, squeezed on the axis. */
export interface AxisBreak {
  from: number;
  to: number;
}

/** Each squeezed stretch takes this share of the axis's width. */
const SLIVER = 0.02;

/**
 * A time axis that squeezes the stretches where nothing was recorded,
 * those over three times the usual spacing between points (and at least
 * `minGap` ms), to a sliver, so what was recorded fills the chart and the
 * line runs on across the break instead of leaving an empty middle.
 */
export function timeAxis(
  times: number[],
  start: number,
  end: number,
  minGap = 0,
) {
  const sorted = [...new Set(times)]
    .filter((t) => t >= start && t <= end)
    .sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!);
  const usual =
    [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
  const threshold = Math.max(usual * 3, minGap);
  const breaks: AxisBreak[] = [];
  if (usual > 0) {
    gaps.forEach((gap, i) => {
      if (gap > threshold)
        breaks.push({ from: sorted[i]!, to: sorted[i + 1]! });
    });
  }
  const span = Math.max(end - start, 1);
  const hidden = breaks.reduce((sum, b) => sum + (b.to - b.from), 0);
  // The sliver is a share of the width, whatever the time it stands for.
  const kept = Math.max(span - hidden, 1);
  const sliver = breaks.length
    ? (kept * SLIVER) / (1 - SLIVER * breaks.length)
    : 0;
  const total = kept + sliver * breaks.length;

  /** Time to a share of the width, 0 to 1. */
  const x = (t: number) => {
    let at = Math.min(Math.max(t, start), end) - start;
    for (const b of breaks) {
      if (t >= b.to) at -= b.to - b.from - sliver;
      // Inside a break, time moves across the sliver at the same pace.
      else if (t > b.from) {
        const into = t - b.from;
        at -= into - sliver * (into / (b.to - b.from));
      }
    }
    return Math.min(1, Math.max(0, at / total));
  };
  /** A share of the width back to the time it shows. */
  const time = (share: number) => {
    let lo = start;
    let hi = end;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (x(mid) < share) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return { x, time, breaks };
}
