// Pairing and motion-trace helpers shared by grade.mjs and keyframes.mjs.

// Change thresholds for motion samples. These only decide what counts as a change.
const CHANGE_PX = 0.5;
const CHANGE_OPACITY = 0.01;

export function centerOf(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function centerDistance(a, b) {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

// Greedy nearest pairing within each key.
// Every A x B candidate in a key is sorted by centre distance (ties: lower A index, then lower B index).
// A candidate becomes a pair when both of its sides are still unused.
// Items whose boxOf() is null cannot pair. Returned indexes refer to listA and listB.
export function pairNearest(listA, listB, { keyOf, boxOf }) {
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, { a: [], b: [] });
    return groups.get(key);
  };
  listA.forEach((item, index) => {
    if (boxOf(item)) group(keyOf(item)).a.push(index);
  });
  listB.forEach((item, index) => {
    if (boxOf(item)) group(keyOf(item)).b.push(index);
  });

  const candidates = [];
  for (const { a, b } of groups.values()) {
    for (const ia of a) {
      for (const ib of b) {
        candidates.push({ ia, ib, d: centerDistance(boxOf(listA[ia]), boxOf(listB[ib])) });
      }
    }
  }
  candidates.sort((p, q) => p.d - q.d || p.ia - q.ia || p.ib - q.ib);

  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];
  for (const { ia, ib } of candidates) {
    if (usedA.has(ia) || usedB.has(ib)) continue;
    usedA.add(ia);
    usedB.add(ib);
    pairs.push([ia, ib]);
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const unpairedA = listA.map((_, i) => i).filter((i) => !usedA.has(i));
  const unpairedB = listB.map((_, i) => i).filter((i) => !usedB.has(i));
  return { pairs, unpairedA, unpairedB };
}

// Trace samples are [x, y, w, h, opacity] or null when the element has no box.
// True when two samples differ enough to count as a change. Null against a box always counts.
export function sampleChanged(a, b) {
  if (!a || !b) return Boolean(a) !== Boolean(b);
  return (
    Math.abs(a[0] - b[0]) > CHANGE_PX ||
    Math.abs(a[1] - b[1]) > CHANGE_PX ||
    Math.abs(a[2] - b[2]) > CHANGE_PX ||
    Math.abs(a[3] - b[3]) > CHANGE_PX ||
    Math.abs(a[4] - b[4]) > CHANGE_OPACITY
  );
}

// True when some sample in the first `count` differs from sample 0.
export function traceMoves(track, count) {
  for (let k = 1; k < count; k++) {
    if (sampleChanged(track[k], track[0])) return true;
  }
  return false;
}

// First sample index k >= 1 that differs from sample 0, or null.
export function firstChangeIndex(track, count) {
  for (let k = 1; k < count; k++) {
    if (sampleChanged(track[k], track[0])) return k;
  }
  return null;
}

// Last sample index k >= 1 that differs from sample k-1, or null.
export function lastChangeIndex(track, count) {
  for (let k = count - 1; k >= 1; k--) {
    if (sampleChanged(track[k], track[k - 1])) return k;
  }
  return null;
}

// Last non-null sample in the first `count` samples, or null.
export function lastSample(track, count) {
  for (let k = count - 1; k >= 0; k--) {
    if (track[k]) return track[k];
  }
  return null;
}

export function lastBox(track, count) {
  const s = lastSample(track, count);
  return s ? { x: s[0], y: s[1], w: s[2], h: s[3] } : null;
}

// Trace start and end over a list of elements: the first and last sample indexes where anything changes.
export function traceStart(elements, count) {
  let best = null;
  for (const el of elements) {
    const k = firstChangeIndex(el.track, count);
    if (k !== null && (best === null || k < best)) best = k;
  }
  return best;
}

export function traceEnd(elements, count) {
  let best = null;
  for (const el of elements) {
    const k = lastChangeIndex(el.track, count);
    if (k !== null && (best === null || k > best)) best = k;
  }
  return best;
}

// Number of samples in a motion entry. Falls back to the longest track.
export function sampleCount(entry) {
  if (Number.isInteger(entry.samples)) return entry.samples;
  return Math.max(0, ...(entry.elements ?? []).map((el) => el.track?.length ?? 0));
}

// Jump thresholds. A jump is a change between two samples that is large and at least SNAP_RATIO
// times the change on either side of it, such as a marquee that returns to its start.
const SNAP_PX = 4;
const SNAP_OPACITY = 0.2;
const SNAP_RATIO = 4;

// Loop period tolerances: how far a sample may be from the sample one period later.
const PERIOD_PX = 1.5;
const PERIOD_OPACITY = 0.03;
const PERIOD_FRACTION = 0.05; // the period is refined in steps of this many samples

const EPS = 1e-9;

// Largest change of x, y, w or h between two samples.
export function boxChange(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
}

// Sample at a fractional index u, interpolated linearly between its two neighbours.
// Null when a neighbour has no box.
export function sampleAt(track, u) {
  const lo = Math.floor(u + EPS);
  const f = u - lo;
  const a = track[lo] ?? null;
  if (f < EPS) return a;
  const b = track[lo + 1] ?? null;
  if (!a || !b) return null;
  return a.map((v, j) => v + (b[j] - v) * f);
}

// Indexes k where the element jumps between samples k - 1 and k. Samples next to a missing box
// never count as a jump.
export function snapIndexes(track, count) {
  const n = Math.min(count, track.length);
  const px = [];
  const op = [];
  for (let k = 1; k < n; k++) {
    const a = track[k - 1];
    const b = track[k];
    px[k] = a && b ? boxChange(a, b) : 0;
    op[k] = a && b ? Math.abs(a[4] - b[4]) : 0;
  }
  const jumps = (list, min, k) =>
    list[k] >= min && list[k] >= SNAP_RATIO * (list[k - 1] ?? 0) && list[k] >= SNAP_RATIO * (list[k + 1] ?? 0);
  const out = [];
  for (let k = 1; k < n; k++) {
    if (!track[k] || !track[k - 1]) continue;
    if (jumps(px, SNAP_PX, k) || jumps(op, SNAP_OPACITY, k)) out.push(k);
  }
  return out;
}

// Jumps plus the indexes where the element appears or disappears (a box on one side only).
export function jumpIndexes(track, count) {
  const n = Math.min(count, track.length);
  const out = new Set(snapIndexes(track, n));
  for (let k = 1; k < n; k++) {
    if (Boolean(track[k]) !== Boolean(track[k - 1])) out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

// True when position p (a sample index, possibly fractional) reads a sample at either end of a jump
// in the set. p reads samples floor(p) and ceil(p); jump j sits between samples j - 1 and j.
export function touchesJump(p, jumps) {
  if (!jumps.size) return false;
  const hi = Math.ceil(p - EPS) + 1;
  for (let j = Math.floor(p + EPS); j <= hi; j++) {
    if (jumps.has(j)) return true;
  }
  return false;
}

// Loop period of one track in samples (fractional), or null when the track does not repeat
// within its first `count` samples. The track has to move away from itself first, then come back:
// the period is the first lag where every sample is within PERIOD_PX (and PERIOD_OPACITY) of the
// sample one lag later, kept going while the difference still falls, then refined to a fraction
// of a sample. Samples next to a jump are skipped. Tracks with a missing box return null.
export function loopPeriod(track, count) {
  const n = Math.min(count, track.length);
  for (let k = 0; k < n; k++) if (!track[k]) return null;
  const jumps = new Set(snapIndexes(track, n));
  // Largest difference at this lag, in units of the tolerance. Null when too few samples overlap.
  const errorAt = (lag) => {
    let worst = 0;
    let used = 0;
    for (let k = 0; k + lag <= n - 1 + EPS; k++) {
      if (touchesJump(k, jumps) || touchesJump(k + lag, jumps)) continue;
      const a = track[k];
      const b = sampleAt(track, k + lag);
      worst = Math.max(worst, boxChange(a, b) / PERIOD_PX, Math.abs(a[4] - b[4]) / PERIOD_OPACITY);
      used++;
    }
    return used >= Math.max(5, Math.ceil(lag / 4)) ? worst : null;
  };

  let departed = false;
  let lag = null;
  let error = Infinity;
  for (let L = 1; L < n; L++) {
    const e = errorAt(L);
    if (e === null) break;
    if (!departed) {
      departed = e > 2;
      continue;
    }
    if (e <= 1) {
      lag = L;
      error = e;
      for (let next = errorAt(lag + 1); next !== null && next < error; next = errorAt(lag + 1)) {
        lag++;
        error = next;
      }
      break;
    }
  }
  if (lag === null) return null;

  let period = lag;
  const steps = Math.round(1 / PERIOD_FRACTION);
  for (let i = -steps + 1; i < steps; i++) {
    const p = lag + i * PERIOD_FRACTION;
    if (i === 0 || p <= 1) continue;
    const e = errorAt(p);
    if (e !== null && e < error - EPS) {
      error = e;
      period = p;
    }
  }
  return Math.round(period * 100) / 100;
}
