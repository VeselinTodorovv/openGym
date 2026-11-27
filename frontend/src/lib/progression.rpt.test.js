import { describe, it, expect } from 'vitest'
import {
  POLICIES, POLICIES_FOR, POLICY_NAME, POLICY_DESC, DELOAD_AFTER,
  rptBackoffPctOf, rptBackoffModeOf, rptTopMinRirOf, rptRowWeights,
  nextPrescription, readSession, stallCount, sessionsFor, applyPrescription,
} from './progression.js'
import { isBackoff, snapBackoff, rptWeightsFrom } from './backoff.js'
import { backoffGrid, withPlatePairs } from './plates.js'
import { withDumbbells, withStack } from './dumbbells.js'
import { buildSessionEntries, buildPlannedEntry, plannedConfigOf } from './session-start.js'
import { finishCompare } from './finish-compare.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { buildPlanBundle, parsePlan, mergePlan } from './plan-share.js'
import { convertStateUnit } from './units.js'
import { withExUnit } from './ex-unit.js'
import { routineFromSession } from './session-routines.js'
import { cascadeWeight } from './history.js'
import { isWarmupRow, isSideSet, makeSideSet, setSideField, toggleSide, WEIGHT_ORIGIN_MANUAL } from './workout-model.js'
import { EXDB, isAssisted } from './exercises.js'

const BENCH = '0025' // barbell bench press — 20 kg bar, 2.5 kg step
const DB_BENCH = EXDB.find(e => e.eq === 'dumbbell' && !['upper legs', 'lower legs', 'back', 'hips', 'glutes'].includes(e.bp) && !isAssisted(e.id)).id
const CABLE_ROW = EXDB.find(e => e.eq === 'cable' && !isAssisted(e.id)).id
const ASSISTED_DIP = EXDB.find(e => isAssisted(e.id)).id
const PUSHUP = '0662' // bodyweight push-up

const work = rows => rows.filter(s => !isWarmupRow(s))

function rig(cfg, extra = {}) {
  const routine = { id: 'r-rpt', name: 'Upper A', ...(extra.routine || {}), ex: [cfg] }
  const { routine: _r, ...rest } = extra
  let day = 0
  let st = { unit: 'kg', effort: 'rpe', workouts: [], exWeights: {}, routines: [routine], ...rest }
  return {
    get st() { return st },
    set st(next) { st = next },
    routine,
    open() {
      return buildSessionEntries(st, routine)[0]
    },
    train(edit = () => ({}), workoutExtra = {}) {
      const [entry] = buildSessionEntries(st, routine)
      let k = -1
      const sets = entry.sets.map(s => {
        if (isWarmupRow(s)) return { ...s, done: true }
        k++
        const patch = typeof edit === 'function' ? (edit(s, k) || {}) : (edit || {})
        return { ...s, done: true, ...patch }
      })
      day++
      const { excludeFromProgression, ...restExtra } = workoutExtra
      const active = {
        id: 'w' + day,
        d: `2026-04-${String(day).padStart(2, '0')}`,
        start: day * 60000,
        routineId: routine.id,
        routineIds: [routine.id],
        name: routine.name,
        entries: [{ ...entry, rid: routine.id, ...(excludeFromProgression ? { noProg: true } : {}), sets }],
        ...restExtra,
      }
      const saved = buildCompletedWorkout(active, { end: active.start + 1800000 })
      st = { ...st, workouts: [...st.workouts, saved] }
      return saved
    },
  }
}

describe('Top set & back-offs (`rpt`) policy metadata & config helpers', () => {
  it('registers `rpt` for rep work with plain-English copy and a 3-session deload threshold', () => {
    expect(POLICIES).toContain('rpt')
    expect(POLICIES_FOR.reps).toContain('rpt')
    expect(POLICIES_FOR.time).not.toContain('rpt')
    expect(POLICIES_FOR.cardio).not.toContain('rpt')
    expect(POLICY_NAME.rpt).toBe('Top set & back-offs')
    expect(POLICY_DESC.rpt).toBeTruthy()
    expect(POLICY_DESC.rpt).not.toMatch(/—/)
    expect(DELOAD_AFTER.rpt).toBe(3)
  })

  it('normalizes backoffPct, backoffMode, and topMinRir (preserving explicit 0 as Off)', () => {
    expect(rptBackoffPctOf({})).toBe(10)
    expect(rptBackoffPctOf({ backoffPct: 5 })).toBe(5)
    expect(rptBackoffPctOf({ backoffPct: '15' })).toBe(15)
    expect(rptBackoffPctOf({ backoffPct: 12 })).toBe(10)

    expect(rptBackoffModeOf({})).toBe('flat')
    expect(rptBackoffModeOf({ backoffMode: 'step' })).toBe('step')
    expect(rptBackoffModeOf({ backoffMode: 'bogus' })).toBe('flat')

    expect(rptTopMinRirOf({})).toBe(1)
    expect(rptTopMinRirOf({ topMinRir: 0 })).toBe(0)
    expect(rptTopMinRirOf({ topMinRir: '0' })).toBe(0)
    expect(rptTopMinRirOf({ topMinRir: 'off' })).toBe(0)
    expect(rptTopMinRirOf({ topMinRir: false })).toBe(0)
    expect(rptTopMinRirOf({ topMinRir: 2 })).toBe(2)
    expect(rptTopMinRirOf({ topMinRir: 99 })).toBe(1)
  })

  it('suppresses the flat-step cfg.backoff switch whenever prog is `rpt`', () => {
    expect(isBackoff({ mode: 'reps', backoff: true, prog: 'double' })).toBe(true)
    expect(isBackoff({ mode: 'reps', backoff: true, prog: 'rpt' })).toBe(false)
    const r = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, backoff: true, prog: 'rpt' })
    const entry = r.open()
    expect(entry.target.backoffStep).toBeUndefined()
    expect(work(entry.sets).map(s => s.w)).toEqual([80, 72.5, 72.5])
  })
})

describe('Nearest-grid snapping (`snapBackoff`, `rptWeightsFrom`, `backoffGrid`)', () => {
  it('snaps to nearest step (80 kg - 10% = 72 -> 72.5 kg on a 2.5 kg step) in flat and step modes', () => {
    expect(rptWeightsFrom(80, 3, { pct: 10, mode: 'flat', grid: 2.5, floor: 20 })).toEqual([80, 72.5, 72.5])
    expect(rptWeightsFrom(80, 3, { pct: 10, mode: 'step', grid: 2.5, floor: 20 })).toEqual([80, 72.5, 65])
    expect(rptWeightsFrom(80, 1, { pct: 10, mode: 'flat', grid: 2.5, floor: 20 })).toEqual([80])
  })

  it('steps down 1 increment only when nearest rounding equals prev, without re-stepping flat sets 3+', () => {
    // 30 * 0.95 = 28.5 -> nearest on 5 kg step is 30 === prev -> Set 2 steps down to 25; flat Sets 3-4 stay 25.
    expect(rptWeightsFrom(30, 4, { pct: 5, mode: 'flat', grid: 5, floor: 0 })).toEqual([30, 25, 25, 25])
    // In step mode, each subsequent set compares against the previous set and steps down 1 increment if equal.
    expect(rptWeightsFrom(30, 4, { pct: 5, mode: 'step', grid: 5, floor: 0 })).toEqual([30, 25, 20, 15])
  })

  it('respects barFloor on barbells and positive step floor on non-bar lifts', () => {
    expect(rptWeightsFrom(22.5, 3, { pct: 15, mode: 'step', grid: 2.5, floor: 20 })).toEqual([22.5, 20, 20])
    expect(rptWeightsFrom(20, 3, { pct: 10, mode: 'flat', grid: 2.5, floor: 20 })).toEqual([20, 20, 20])
    expect(rptWeightsFrom(2.5, 3, { pct: 15, mode: 'step', grid: 2.5, floor: 0 })).toEqual([2.5, 2.5, 2.5])
  })

  it('snaps to nearest owned dumbbell or custom machine stack pin, clamping at the lightest & heaviest', () => {
    const bells = [10, 12.5, 15, 17.5, 20, 24, 28, 32]
    // 32 * 0.9 = 28.8 -> nearest is 28 (< 32)
    expect(rptWeightsFrom(32, 3, { pct: 10, mode: 'flat', grid: bells })).toEqual([32, 28, 28])
    // 20 * 0.95 = 19 -> nearest is 20 === prev -> steps down 1 bell to 17.5
    expect(rptWeightsFrom(20, 3, { pct: 5, mode: 'flat', grid: bells })).toEqual([20, 17.5, 17.5])
    // At lightest bell (10), holds 10
    expect(rptWeightsFrom(10, 3, { pct: 15, mode: 'step', grid: bells })).toEqual([10, 10, 10])

    let st = { unit: 'kg', effort: 'rpe', workouts: [], exWeights: {} }
    st.stackWeights = withStack(st, CABLE_ROW, [5, 11.3, 18.1, 24.9, 31.8])
    const cfg = { id: CABLE_ROW, sets: 3, reps: 10, repsMin: 7, weight: 31.8, prog: 'rpt' }
    const r = rig(cfg, { stackWeights: st.stackWeights })
    // 31.8 * 0.9 = 28.62 -> 24.9 (dist 3.72) vs 31.8 (dist 3.18 -> equals prev -> steps down to 24.9)
    expect(work(r.open().sets).map(s => s.w)).toEqual([31.8, 24.9, 24.9])
    // Hitting top of range at heaviest stack pin holds with toppedOut explanation
    r.train((s, k) => (k === 0 ? { r: 10, rpe: 8 } : { r: 8 }))
    const next = nextPrescription(r.st, cfg, r.routine, { grid: backoffGrid(r.st, cfg) })
    expect(next).toMatchObject({ kind: 'hold', weight: 31.8, reps: 10, rowWeights: [31.8, 24.9, 24.9] })
    expect(next.why[0]).toMatch(/whole stack/)
  })

  it('snaps to nearest loadable plate combination when the profile counts custom gym plates', () => {
    // Gym with only 5 kg plates (20 kg bar + pairs of 5 -> 20, 30, 40, 50, 60, 70, 80)
    let st = { unit: 'kg' }
    st.plates = { kg: { 5: 6, _ts: 1 } }
    const grid5 = backoffGrid(st, { id: BENCH })
    // 80 * 0.9 = 72 -> nearest between 70 (dist 2) and 80 (dist 8) is 70
    expect(snapBackoff(72, 80, grid5, 20)).toBe(70)
    // 40 * 0.95 = 38 -> nearest between 30 (dist 8) and 40 (dist 2) is 40 === prev -> steps down 1 jump to 30
    expect(snapBackoff(38, 40, grid5, 20)).toBe(30)

    // Add 1.25 kg change plates -> 72.5 kg is now loadable, and closer to 72 than 70 is!
    st = { unit: 'kg', plates: withPlatePairs(st, 1.25, 2, 2) }
    const grid125 = backoffGrid(st, { id: BENCH })
    expect(snapBackoff(72, 80, grid125, 20)).toBe(72.5)
  })
})

describe('First session & warm-up ramping', () => {
  it('populates top + back-off weights on session 1 when cfg.weight > 0 and ramps warm-ups to Set 1', () => {
    const r = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, warmupSets: 2, prog: 'rpt' })
    const entry = r.open()
    expect(entry.plan).toMatchObject({ policy: 'rpt', kind: 'first', weight: 80, reps: 7, rowWeights: [80, 72.5, 72.5] })
    expect(entry.target).toMatchObject({ weight: 80, reps: 7, rowWeights: [80, 72.5, 72.5], rpt: { pct: 10, mode: 'flat' } })
    expect(entry.sets.filter(isWarmupRow).map(s => [s.w, s.r])).toEqual([[40, 7], [60, 7]])
    expect(work(entry.sets).map(s => [s.w, s.r])).toEqual([[80, 7], [72.5, 7], [72.5, 7]])
  })

  it('prefers confirmed working weight over cfg.weight on session 1, and leaves 0 kg open when unset', () => {
    const rConf = rig(
      { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 60, prog: 'rpt' },
      { exWeights: { [BENCH]: { w: 100, d: '2026-04-01' } } }
    )
    expect(work(rConf.open().sets).map(s => s.w)).toEqual([100, 90, 90])

    const rZero = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 0, prog: 'rpt' })
    const zeroEntry = rZero.open()
    expect(zeroEntry.plan.rowWeights).toBeUndefined()
    expect(work(zeroEntry.sets).map(s => [s.w, s.r])).toEqual([[0, 7], [0, 7], [0, 7]])
  })
})

describe('Between-session progression driven strictly by Set 1', () => {
  const cfg = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, inc: 2.5, warmupSets: 1, mode: 'reps', prog: 'rpt' }

  it('levels up when Set 1 hits top of range within effort cap, even when back-offs miss or are skipped', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { r: 10, rpe: 8.5 } : k === 1 ? { r: 5 } : { done: false }))
    const e2 = r.open()
    expect(e2.plan).toMatchObject({
      policy: 'rpt', kind: 'up', weight: 82.5, reps: 7, rowWeights: [82.5, 75, 75],
    })
    expect(work(e2.sets).map(s => [s.w, s.r])).toEqual([[82.5, 7], [75, 7], [75, 7]])
  })

  it('falls back to rep-only progression when effort tracking is off, topMinRir is 0, or Set 1 is unrated', () => {
    // Unrated Set 1
    const rUnrated = rig(cfg)
    rUnrated.train((s, k) => (k === 0 ? { r: 10 } : { r: 8 }))
    expect(rUnrated.open().plan).toMatchObject({ kind: 'up', weight: 82.5, reps: 7 })

    // Effort scale 'none' even if RPE 10 was stored
    const rNone = rig(cfg, { effort: 'none' })
    rNone.train((s, k) => (k === 0 ? { r: 10, rpe: 10 } : { r: 8 }))
    expect(rNone.open().plan).toMatchObject({ kind: 'up', weight: 82.5, reps: 7 })

    // topMinRir: 0 (Off) even if RPE 10 / failure was logged
    const rOff = rig({ ...cfg, topMinRir: 0 })
    rOff.train((s, k) => (k === 0 ? { r: 10, rpe: 10, failure: true } : { r: 8 }))
    expect(rOff.open().plan).toMatchObject({ kind: 'up', weight: 82.5, reps: 7 })
  })

  it('holds weight when Set 1 exceeds effort cap (RPE & RIR scales) and NEVER counts it as a stall', () => {
    const rRpe = rig(cfg, { effort: 'rpe' })
    for (let i = 0; i < 4; i++) {
      rRpe.train((s, k) => (k === 0 ? { r: 10, rpe: 9.5 } : { r: 8 }))
    }
    const pRpe = rRpe.open().plan
    expect(pRpe).toMatchObject({ kind: 'hold', weight: 80, reps: 10, rowWeights: [80, 72.5, 72.5] })
    expect(pRpe.why[0]).toContain('RPE')
    expect(stallCount(sessionsFor(rRpe.st, BENCH, cfg, rRpe.routine.id), 'rpt', cfg)).toBe(0)

    const rRir = rig({ ...cfg, topMinRir: 2 }, { effort: 'rir' })
    rRir.train((s, k) => (k === 0 ? { r: 10, rir: 1 } : { r: 8 }))
    const pRir = rRir.open().plan
    expect(pRir).toMatchObject({ kind: 'hold', weight: 80, reps: 10 })
    expect(pRir.why[0]).toContain('RIR')
    expect(pRir.why).toEqual(['Top set hit {0} reps with {1} RIR (need {2}+ RIR). Hold {3} {4} until you have more in reserve.', 10, 1, 2, 80, 'kg'])
  })

  it('climbs reps inside the range without counting in-range holds as stalls', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { r: 7, rpe: 8 } : { r: 7 }))
    expect(r.open().plan).toMatchObject({ kind: 'hold', weight: 80, reps: 8, rowWeights: [80, 72.5, 72.5] })
    r.train((s, k) => (k === 0 ? { r: 8, rpe: 8.5 } : { r: 7 }))
    expect(r.open().plan).toMatchObject({ kind: 'hold', weight: 80, reps: 9 })
    r.train((s, k) => (k === 0 ? { r: 9, rpe: 9 } : { r: 7 }))
    expect(r.open().plan).toMatchObject({ kind: 'hold', weight: 80, reps: 10 })
    r.train((s, k) => (k === 0 ? { r: 10, rpe: 9 } : { r: 7 }))
    expect(r.open().plan).toMatchObject({ kind: 'up', weight: 82.5, reps: 7 })
  })

  it('triggers an Epley deload with recalculated back-off rows after 3 Set 1 misses below repsMin (ignoring excluded sessions)', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { r: 6 } : { r: 10 }))
    expect(r.open().plan.kind).toBe('hold')
    r.train((s, k) => (k === 0 ? { r: 5 } : { r: 10 }))
    expect(r.open().plan.kind).toBe('hold')
    // Excluded rough-day session does not advance stall count to 3
    r.train(() => ({ r: 3 }), { excludeFromProgression: true })
    expect(r.open().plan.kind).toBe('hold')
    // Third counting miss triggers deload
    r.train((s, k) => (k === 0 ? { r: 5 } : { r: 10 }))
    const deloaded = r.open()
    expect(deloaded.plan.kind).toBe('deload')
    expect(deloaded.plan.weight).toBeLessThan(80)
    expect(deloaded.plan.rowWeights).toEqual(
      rptRowWeights(deloaded.plan.weight, 3, cfg, { grid: 2.5, floor: 20 })
    )
    expect(work(deloaded.sets).map(s => s.w)).toEqual(deloaded.plan.rowWeights)
  })

  it('does not level up or drop top weight if Set 1 was left unchecked and only Set 2 was ticked', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { done: false } : { r: 12, rpe: 7 }))
    const next = r.open()
    expect(next.plan).toMatchObject({ kind: 'hold', weight: 80, reps: 7, rowWeights: [80, 72.5, 72.5] })
    expect(stallCount(sessionsFor(r.st, BENCH, cfg, r.routine.id), 'rpt', cfg)).toBe(1)
  })

  it('does not level up when Set 1 was logged lighter than prescribed', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { w: 75, r: 10, rpe: 8 } : { r: 10 }))
    const next = r.open()
    expect(next.plan).toMatchObject({ kind: 'hold', weight: 75, reps: 10, rowWeights: [75, 67.5, 67.5] })
  })

  it('supports unilateral per-side sets (`side: true`) with even rep steps and per-limb back-off weights', () => {
    const uCfg = { id: DB_BENCH, sets: 3, reps: 20, repsMin: 14, weight: 30, inc: 2, side: true, prog: 'rpt' }
    const r = rig(uCfg)
    const e1 = r.open()
    const w1 = work(e1.sets)
    expect(w1.every(isSideSet)).toBe(true)
    expect(w1.map(s => [s.sides.L.w, s.sides.R.w, s.r])).toEqual([[30, 30, 14], [28, 28, 14], [28, 28, 14]])

    // Log 10/side (total 20) @ RPE 8 on both sides of Set 1
    const [built] = buildSessionEntries(r.st, r.routine)
    const sets = built.sets.map((s, idx) => {
      if (idx === 0) {
        let row = setSideField(s, 'L', 'r', 10)
        row = setSideField(row, 'R', 'r', 10)
        row = setSideField(row, 'L', 'rpe', 8)
        row = setSideField(row, 'R', 'rpe', 8.5)
        row = toggleSide(toggleSide(row, 'L'), 'R')
        return row
      }
      return toggleSide(toggleSide(s, 'L'), 'R')
    })
    const saved = buildCompletedWorkout({
      id: 'wu1', d: '2026-04-01', start: 1000, routineId: r.routine.id, routineIds: [r.routine.id], name: 'U',
      entries: [{ ...built, rid: r.routine.id, sets }],
    }, { end: 2000 })
    r.st = { ...r.st, workouts: [saved] }
    const e2 = r.open()
    expect(e2.plan).toMatchObject({ kind: 'up', weight: 32, reps: 14, rowWeights: [32, 28, 28] })
  })
})

describe('Bodyweight (`0 kg`) inheritance guard & assisted lifts', () => {
  it('degrades cleanly to ordinary bodyweight rep climbing when inherited by a 0 kg bodyweight exercise', () => {
    const bwCfg = { id: PUSHUP, sets: 3, reps: 10, repsMax: 12, weight: 0, bodyweight: true }
    const r = rig(bwCfg, { routine: { prog: 'rpt' } })

    const e1 = r.open()
    expect(e1.plan).toMatchObject({ policy: 'rpt', kind: 'first' })
    expect(e1.plan.rowWeights).toBeUndefined()
    expect(e1.target.rowWeights).toBeUndefined()
    expect(e1.target.rpt).toBeUndefined()
    expect(work(e1.sets).map(s => [s.w, s.r])).toEqual([[0, 10], [0, 10], [0, 10]])

    // Short Set 3 holds just like standard bodyweight (not RPT Set-1-only!)
    r.train((s, k) => ({ r: k === 2 ? 8 : 10 }))
    expect(readSession(r.st.workouts[0].entries[0], { ...bwCfg, prog: 'rpt' }).ok).toBe(false)
    const e2 = r.open()
    expect(e2.plan).toMatchObject({ policy: 'rpt', kind: 'hold', weight: 0, reps: 10 })
    expect(e2.plan.rowWeights).toBeUndefined()

    // Clean 3 × 10 climbs to 3 × 11 with no rowWeights
    r.train(() => ({ r: 10 }))
    const e3 = r.open()
    expect(e3.plan).toMatchObject({ policy: 'rpt', kind: 'up', weight: 0, reps: 11 })
    expect(e3.plan.rowWeights).toBeUndefined()
    expect(work(e3.sets).map(s => [s.w, s.r])).toEqual([[0, 11], [0, 11], [0, 11]])
  })

  it('runs full RPT when a bodyweight exercise carries added external weight', () => {
    const weightedPull = { id: PUSHUP, sets: 3, reps: 8, repsMin: 5, weight: 20, inc: 2.5, bodyweight: true, prog: 'rpt' }
    const r = rig(weightedPull)
    expect(work(r.open().sets).map(s => [s.w, s.r])).toEqual([[20, 5], [17.5, 5], [17.5, 5]])
    r.train((s, k) => (k === 0 ? { r: 8, rpe: 8 } : { r: 6 }))
    expect(work(r.open().sets).map(s => [s.w, s.r])).toEqual([[22.5, 5], [20, 5], [20, 5]])
  })

  it('handles inherited `rpt` on assisted machines by omitting rowWeights and stepping assistance down on Set 1 hits', () => {
    const aCfg = { id: ASSISTED_DIP, sets: 3, reps: 10, repsMin: 8, weight: 40, inc: 5 }
    const r = rig(aCfg, { routine: { prog: 'rpt' } })
    const e1 = r.open()
    expect(e1.plan.rowWeights).toBeUndefined()
    expect(work(e1.sets).map(s => [s.w, s.r])).toEqual([[40, 8], [40, 8], [40, 8]])

    r.train((s, k) => (k === 0 ? { r: 10, rpe: 8 } : { r: 7 }))
    const e2 = r.open()
    expect(e2.plan).toMatchObject({ kind: 'up', weight: 35, reps: 8 })
    expect(e2.plan.rowWeights).toBeUndefined()
  })
})

describe('Downstream ecosystem contracts (finishCompare, plan-share, units, session-routines)', () => {
  const cfg = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, inc: 2.5, prog: 'rpt', backoffPct: 15, backoffMode: 'step', topMinRir: 0 }

  it('finishCompare reports the next Top Set weight and reps cleanly after finishing an RPT session', () => {
    const r = rig(cfg)
    const saved = r.train((s, k) => (k === 0 ? { r: 10, rpe: 10 } : { r: 8 }))
    const rows = finishCompare(r.st, saved)
    expect(rows).toHaveLength(1)
    expect(rows[0].next).toEqual({ w: 82.5, r: 7, sets: 3, kind: 'up' })
  })

  it('round-trips non-default RPT config fields (including topMinRir: 0) and omits defaults in plan-share', () => {
    const defaultEx = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt', backoffPct: 10, backoffMode: 'flat', topMinRir: 1 }
    const st = {
      unit: 'kg',
      week: { 1: ['r1'] },
      routines: [{ id: 'r1', name: 'Push', ex: [cfg, defaultEx] }],
    }
    const bundle = buildPlanBundle(st, 'My RPT Plan')
    expect(bundle.routines[0].ex[0]).toMatchObject({ prog: 'rpt', backoffPct: 15, backoffMode: 'step', topMinRir: 0 })
    expect(bundle.routines[0].ex[1].backoffPct).toBeUndefined()
    expect(bundle.routines[0].ex[1].backoffMode).toBeUndefined()
    expect(bundle.routines[0].ex[1].topMinRir).toBeUndefined()

    // Inject invalid junk into raw JSON and confirm parsePlan sanitizes it
    const raw = JSON.parse(JSON.stringify(bundle))
    raw.routines[0].ex[1].backoffPct = 99
    raw.routines[0].ex[1].backoffMode = 'evil'
    raw.routines[0].ex[1].topMinRir = 'evil'
    const parsed = parsePlan(JSON.stringify(raw), 'kg')
    expect(parsed.routines[0].ex[0]).toMatchObject({ prog: 'rpt', backoffPct: 15, backoffMode: 'step', topMinRir: 0 })
    expect(parsed.routines[0].ex[1].backoffPct).toBeUndefined()
    expect(parsed.routines[0].ex[1].backoffMode).toBeUndefined()
    expect(parsed.routines[0].ex[1].topMinRir).toBeUndefined()

    const dest = { unit: 'kg', routines: [], week: {}, customEx: [] }
    mergePlan(dest, parsed, { schedule: true })
    expect(dest.routines[0].ex[0]).toMatchObject({ prog: 'rpt', backoffPct: 15, backoffMode: 'step', topMinRir: 0 })
  })

  it('converts target.rowWeights across profile unit switches and per-exercise unit pins', () => {
    const r = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt' })
    r.train((s, k) => (k === 0 ? { r: 9, rpe: 8 } : { r: 8 }))
    const active = { id: 'act', d: '2026-04-10', entries: [r.open()] }
    const converted = convertStateUnit({ ...r.st, active }, 'lb')
    expect(converted.workouts[0].entries[0].target.rowWeights).toEqual([176.5, 160, 160])
    expect(converted.active.entries[0].target.rowWeights).toEqual([176.5, 160, 160])

    // Per-exercise lb pin on a kg profile builds on the lb grid and stores converted rowWeights
    const pinnedState = { unit: 'kg', exUnit: withExUnit({}, DB_BENCH, 'lb'), workouts: [], exWeights: {}, routines: [] }
    const built = buildPlannedEntry(pinnedState, { id: DB_BENCH, sets: 3, reps: 10, repsMin: 7, weight: 20, prog: 'rpt' }, { id: 'rp', name: 'P' })
    expect(built.target.rowWeights).toHaveLength(3)
    expect(built.target.rowWeights[0]).toBeGreaterThan(built.target.rowWeights[1])
  })

  it('strips session-only `rowWeights` and `rpt` in plannedConfigOf and routineFromSession, keeping Set 1 top weight', () => {
    const r = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt' })
    const liveEntry = r.open()
    const sheetCfg = plannedConfigOf(liveEntry)
    expect(sheetCfg.rowWeights).toBeUndefined()
    expect(sheetCfg.rpt).toBeUndefined()

    const saved = r.train()
    const copied = routineFromSession(saved, 'Copied RPT', r.st.routines)
    expect(copied.ex[0].rowWeights).toBeUndefined()
    expect(copied.ex[0].rpt).toBeUndefined()
    expect(copied.ex[0].weight).toBe(80)
    expect(copied.ex[0].reps).toBe(10)
    expect(copied.ex[0].repsMin).toBe(7)
  })

  it('keeps lighter back-off weights on scheduled deload weeks instead of flattening Set 2 to the top weight', () => {
    const r = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt' })
    r.train((s, k) => (k === 0 ? { r: 8, rpe: 8 } : { r: 8 }))
    // Deload week scheduled on the active session's week ('2026-04-06' is Monday)
    r.st = {
      ...r.st,
      deloadCycle: { extra: ['2026-04-06'] },
      active: { id: 'dw1', d: '2026-04-06' },
    }
    const deloadEntry = r.open()
    expect(deloadEntry.plan.kind).toBe('deloadweek')
    expect(work(deloadEntry.sets).map(s => s.w)).toEqual([80, 72.5])
    expect(deloadEntry.target.rowWeights).toEqual([80, 72.5])
  })
})

describe('Live workout cascadeWeight for RPT', () => {
  const flatSpec = { pct: 10, mode: 'flat', grid: 2.5, floor: 20 }
  const stepSpec = { pct: 10, mode: 'step', grid: 2.5, floor: 20 }

  it('recalculates open back-off sets onto nearest grid when Set 1 is edited live (flat & step)', () => {
    const rows = [
      { w: 40, r: 8, phase: 'warmup', done: true },
      { w: 60, r: 5, warmup: true, done: false },
      { w: 85, r: 7, done: false },
      { w: 72.5, r: 7, done: false },
      { w: 72.5, r: 7, done: false },
    ]
    // 85 * 0.9 = 76.5 -> nearest 2.5 step is 77.5; 85 * 0.8 = 68 -> nearest 2.5 step is 67.5
    const flatOut = cascadeWeight(rows, 2, 85, undefined, flatSpec)
    expect(flatOut.map(r => r.w)).toEqual([40, 60, 85, 77.5, 77.5])

    const stepOut = cascadeWeight(rows, 2, 85, undefined, stepSpec)
    expect(stepOut.map(r => r.w)).toEqual([40, 60, 85, 77.5, 67.5])
  })

  it('populates real back-off loads on Day 1 when Set 1 is edited from 0 -> 80 kg', () => {
    const rows = [
      { w: 80, r: 7, done: false },
      { w: 0, r: 7, done: false },
      { w: 0, r: 7, done: false },
    ]
    const out = cascadeWeight(rows, 0, 80, undefined, flatSpec)
    expect(out.map(r => r.w)).toEqual([80, 72.5, 72.5])
  })

  it('cascades flat when Set 2 is manually overridden in flat mode, and uses relative step offset in step mode', () => {
    const baseRows = [
      { w: 40, r: 8, phase: 'warmup', done: true },
      { w: 80, r: 8, done: true },
      { w: 70, r: 7, done: false, weightOrigin: WEIGHT_ORIGIN_MANUAL },
      { w: 72.5, r: 7, done: false },
      { w: 72.5, r: 7, done: false },
    ]
    // Flat mode: editing Set 2 (index 2, fromWorkIdx = 1) to 70 cascades 70 across Sets 3 & 4
    const flatOut = cascadeWeight(baseRows, 2, 70, undefined, flatSpec)
    expect(flatOut.map(r => r.w)).toEqual([40, 80, 70, 70, 70])

    // Step mode: relative offset (workIdx - fromWorkIdx) * pct from 70 kg:
    // Set 3 (offset 1): 70 * 0.9 = 63 -> 62.5 kg (NOT 70 * 0.8 = 56!)
    // Set 4 (offset 2): 70 * 0.8 = 56 -> 55 kg (NOT 70 * 0.7 = 49!)
    const stepOut = cascadeWeight(baseRows, 2, 70, undefined, stepSpec)
    expect(stepOut.map(r => r.w)).toEqual([40, 80, 70, 62.5, 55])
  })

  it('preserves completed rows and manual weight overrides while holding sequence positions', () => {
    const rows = [
      { w: 90, r: 7, done: false },
      { w: 72.5, r: 8, done: true },
      { w: 75, r: 7, done: false, weightOrigin: WEIGHT_ORIGIN_MANUAL },
      { w: 65, r: 7, done: false },
    ]
    // Step mode from 90: seq = [90, 80, 72.5, 62.5]; Set 2 (done) stays 72.5, Set 3 (manual) stays 75, Set 4 gets 62.5
    const out = cascadeWeight(rows, 0, 90, undefined, stepSpec)
    expect(out.map(r => r.w)).toEqual([90, 72.5, 75, 62.5])
  })

  it('cascades unilateral side sets per limb or both limbs while preserving done/manual limbs', () => {
    const dbSpec = { pct: 10, mode: 'step', grid: [16, 18, 20, 22, 24, 26, 28, 30], floor: 0 }
    const s1 = setSideField(makeSideSet({ w: 30, r: 8 }), 'L', 'w', 30)
    const s2DoneR = toggleSide(makeSideSet({ w: 26, r: 8 }), 'R')
    const s3 = makeSideSet({ w: 24, r: 8 })

    // Edit only Left side of Set 1 to 28 -> Left cascades [28, 26, 22], Right on s2 (done) stays 26 and s3 Right stays 24
    const leftOnly = cascadeWeight([setSideField(s1, 'L', 'w', 28), s2DoneR, s3], 0, 28, 'L', dbSpec)
    expect(leftOnly[1].sides.L.w).toBe(26)
    expect(leftOnly[1].sides.R.w).toBe(26)
    expect(leftOnly[2].sides.L.w).toBe(22)
    expect(leftOnly[2].sides.R.w).toBe(24)

    // Edit both sides (side = undefined) from Set 1 = 30 -> [30, 28, 24] on open limbs
    const both = cascadeWeight([s1, makeSideSet({ w: 20, r: 8 }), makeSideSet({ w: 20, r: 8 })], 0, 30, undefined, dbSpec)
    expect(both.map(r => [r.sides.L.w, r.sides.R.w])).toEqual([[30, 30], [28, 28], [24, 24]])
  })

  it('clamps cascaded weights at barFloor and deletes weight cleanly when cleared (value = null)', () => {
    const rows = [
      { w: 22.5, r: 7, done: false },
      { w: 20, r: 7, done: false },
      { w: 20, r: 7, done: false },
    ]
    const clamped = cascadeWeight(rows, 0, 22.5, undefined, stepSpec)
    expect(clamped.map(r => r.w)).toEqual([22.5, 20, 20])

    const cleared = cascadeWeight(clamped, 0, null, undefined, stepSpec)
    expect(cleared[1].w).toBeUndefined()
    expect(cleared[2].w).toBeUndefined()
  })
})
