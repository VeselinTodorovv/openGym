// Back-off sets: every work set one weight step lighter than the one before it — with a 2 kg
// step, a plan of 3 × 6 @ 26 kg trains as 26 → 24 → 22. The step is the exercise's own
// progression step (cfg.inc, "Step" in its settings), so dumbbells drop by the 2 kg the rack
// goes up in and a lever machine by its 5 kg, without a second number to keep in line.
//
// Only the first set's weight is planned and progressed; the others are derived from it every
// time a session is built, so a raise of the top set carries the whole sequence with it
// (26/24/22 → 28/26/24). Whether it is raised is the ordinary policy's call, which already
// reads every planned set: one back-off set short of its reps holds the whole sequence.
//
// Imports nothing from history.js or progression.js — both import this module.
import { isWarmupRow, isSideSet, syncSideAggregate } from './workout-model.js'
import { defaultIncrement, isAssisted } from './exercises.js'
import { ownedDown } from './dumbbells.js'

const round1 = v => Math.round(v * 10) / 10
const stepPlaces = step => {
  const s = String(Number(step) || 0)
  const i = s.indexOf('.')
  return i < 0 || /e/i.test(s) ? 1 : Math.min(3, Math.max(1, s.length - i - 1))
}
const roundToStep = (v, step) => { const p = 10 ** stepPlaces(step); return Math.round(v * p) / p + 0 }
const tidy3 = v => Math.round(v * 1000) / 1000

/** Whether a plan asks for back-off sets. Off unless switched on, so every plan saved before
 *  this field existed builds exactly as it did. A pyramid owns each set already, a rest-pause
 *  trains one work set, and `rpt` runs its own percentage back-offs, so none of them use this. */
export function isBackoff(cfg) {
  return !!cfg && cfg.backoff === true && (cfg.mode || 'reps') === 'reps'
    && cfg.prog !== 'rpt'
    && !(Array.isArray(cfg.pyramid) && cfg.pyramid.length)
    && cfg.intensifier?.type !== 'restpause'
}

/**
 * The weight of work set `k` (0 = the top set) below a top set of `top`. The same grid rule a
 * stepper tap uses: a top set on the step's grid lands every back-off set on it, one typed off
 * the grid steps down from where it is. Never below one step — an empty bar is not a set — and
 * never above the top set itself.
 */
export function backoffAt(top, k, step) {
  const t = Number(top) || 0
  const s = Number(step) || 0
  if (!(t > 0) || !(s > 0) || !(k > 0)) return t
  const raw = t - k * s
  const onGrid = Math.abs(t - Math.round(t / s) * s) <= 0.1
  const v = onGrid ? round1(Math.round(raw / s) * s) : round1(raw)
  return Math.max(Math.min(t, s), v)
}

/** The step back-off sets use: the exercise's own (cfg.inc), else its default — the same
 *  number progression.js's weightIncrement gives, and 0 where back-off sets do not apply. An
 *  assistance machine is left out: less load is harder there, so "lighter" is the wrong way. */
export function backoffStepOf(cfg, unit) {
  if (!isBackoff(cfg) || isAssisted(cfg)) return 0
  return cfg.inc > 0 ? cfg.inc : defaultIncrement(cfg.id, unit)
}

/** The planned weights for `n` work sets: "26 → 24 → 22". */
export function backoffWeights(top, n, step) {
  return Array.from({ length: Math.max(0, n) }, (_, k) => backoffAt(top, k, step))
}

/**
 * Step the open work rows of a freshly built entry down from its first work row. Warm-ups are
 * left alone (they ramp toward the top set), a logged row is never rewritten, and a per-side
 * row steps both limbs.
 */
export function applyBackoff(rows, step) {
  if (!(step > 0)) return rows
  const first = rows.find(r => !isWarmupRow(r))
  const top = first ? Number(first.w) || 0 : 0
  if (!(top > 0)) return rows
  let k = -1
  return rows.map(row => {
    if (isWarmupRow(row)) return row
    k++
    if (k === 0) return row
    const w = backoffAt(top, k, step)
    if (isSideSet(row)) {
      const side = s => (s.done ? s : { ...s, w })
      return syncSideAggregate({ ...row, sides: { L: side(row.sides.L), R: side(row.sides.R) } })
    }
    return row.done ? row : { ...row, w }
  })
}

/**
 * Nearest loadable back-off weight at or under `prev` for a target `raw` (`top * (1 - pct/100)`),
 * over an owned list (dumbbells or machine stack), a custom plate-loader function (`plates.js`
 * backoffGrid), or a numeric step. Ties break to the heavier load; only when nearest rounding
 * lands right back on `prev` does it step down by one increment, while never crossing under
 * `floor` (the empty bar) or the lightest loadable step/bell/pin, and never above `prev`.
 */
export function snapBackoff(raw, prev, grid = 2.5, floor = 0) {
  const p = Number(prev) || 0
  if (!(p > 0)) return 0
  const fl = Math.max(0, Number(floor) || 0)
  const r = Math.min(p, Math.max(0, Number(raw) || 0))

  if (Array.isArray(grid) && grid.length) {
    const cands = grid.filter(x => x > 0 && x <= p + 1e-6 && (fl > 0 ? x >= fl - 1e-6 : true))
    if (!cands.length) return p
    let w = cands.reduce((best, x) => {
      const dx = Math.abs(x - r), db = Math.abs(best - r)
      return dx < db - 1e-6 || (Math.abs(dx - db) <= 1e-6 && x > best) ? x : best
    }, cands[0])
    if (w >= p - 1e-6) {
      const down = ownedDown(cands, p)
      if (down != null) w = down
    }
    return tidy3(Math.min(p, w))
  }

  if (typeof grid === 'function') {
    const minW = Math.min(p, fl)
    const w = Number(grid(r, p))
    if (!Number.isFinite(w) || !(w > 0)) return minW > 0 ? minW : p
    return tidy3(Math.max(minW, Math.min(p, w)))
  }

  const step = Number(grid) > 0 ? Number(grid) : 2.5
  const minW = Math.min(p, fl > 0 ? fl : step)
  const low = roundToStep(Math.floor(r / step) * step, step)
  const high = roundToStep(Math.ceil(r / step) * step, step)
  const cands = [...new Set([low, high])].filter(x => x <= p + 1e-6)
  let w = cands.length
    ? cands.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) - 1e-6 || (Math.abs(Math.abs(x - r) - Math.abs(best - r)) <= 1e-6 && x > best) ? x : best), cands[0])
    : roundToStep(p - step, step)
  if (w >= p - 1e-6) {
    const onGrid = Math.abs(p - Math.round(p / step) * step) <= Math.min(0.1, step / 4) + 1e-9
    w = onGrid ? roundToStep(Math.round((p - step) / step) * step, step) : roundToStep(p - step, step)
  }
  return roundToStep(Math.max(minW, Math.min(p, w)), step)
}

/**
 * Per-set weights for "Top set & back-offs" (`rpt`): Set 1 at `top`, Sets 2+ dropped by `pct`%
 * in `'flat'` mode (all back-offs equal to Set 2) or `'step'` mode (`k * pct`%, capped at 90%,
 * each snapped under the set before it).
 */
export function rptWeightsFrom(top, count, { pct = 10, mode = 'flat', grid = 2.5, floor = 0 } = {}) {
  const n = Math.max(0, Math.round(Number(count)) || 0)
  const t = Number(top) || 0
  if (n === 0) return []
  if (!(t > 0)) return Array(n).fill(0)
  if (n === 1) return [t]
  const drop = Number(pct) > 0 ? Number(pct) : 10
  if (mode === 'step') {
    const out = [t]
    for (let k = 1; k < n; k++) {
      const totalPct = Math.min(90, k * drop)
      out.push(snapBackoff(t * (1 - totalPct / 100), out[k - 1], grid, floor))
    }
    return out
  }
  const w2 = snapBackoff(t * (1 - drop / 100), t, grid, floor)
  return [t, ...Array(n - 1).fill(w2)]
}
