import { describe, it, expect } from 'vitest'
import {
  POLICIES, POLICIES_FOR, POLICY_NAME, POLICY_DESC, DELOAD_AFTER,
  rptRampOf, rptTargetRirs, rptTopMinRirOf,
  nextPrescription, readSession, stallCount, sessionsFor,
} from './progression.js'
import { isBackoff, snapBackoff, reactiveNextWeight, applyReactiveRpt } from './backoff.js'
import { backoffGrid, withPlatePairs } from './plates.js'
import { withDumbbells, withStack } from './dumbbells.js'
import { buildSessionEntries, buildPlannedEntry, plannedConfigOf } from './session-start.js'
import { finishCompare } from './finish-compare.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { buildPlanBundle, parsePlan, mergePlan } from './plan-share.js'
import { convertStateUnit } from './units.js'
import { withExUnit } from './ex-unit.js'
import { routineFromSession } from './session-routines.js'
import { startProgramme } from './programmes.js'
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

  it('normalizes rptRamp, rptTargetRirs across 1–4+ sets, and topMinRir (preserving explicit 0 as Off)', () => {
    expect(rptRampOf({})).toBe('8-9-10')
    expect(rptRampOf({ rptRamp: '9-9-10' })).toBe('9-9-10')
    expect(rptRampOf({ rptRamp: '9-9-9' })).toBe('9-9-9')
    expect(rptRampOf({ rptRamp: 'bogus' })).toBe('8-9-10')

    expect(rptTargetRirs(3, '8-9-10')).toEqual([2, 1, 0])
    expect(rptTargetRirs(4, '8-9-10')).toEqual([2, 1, 1, 0])
    expect(rptTargetRirs(2, '8-9-10')).toEqual([2, 0])
    expect(rptTargetRirs(1, '8-9-10')).toEqual([2])
    expect(rptTargetRirs(3, '9-9-10')).toEqual([1, 1, 0])
    expect(rptTargetRirs(3, '9-9-9')).toEqual([1, 1, 1])

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
    expect(work(entry.sets).map(s => s.w)).toEqual([80, 80, 80])
  })
})

describe('Equipment grid snapping (`snapBackoff`, `backoffGrid`) & live reactive set adjustments', () => {
  it('snaps dropped loads onto custom plates, owned dumbbells, machine stacks, and barFloor', () => {
    const bells = [10, 12.5, 15, 17.5, 20, 24, 28, 32]
    expect(snapBackoff(28.8, 32, bells, 0)).toBe(28)
    expect(snapBackoff(19.6, 20, bells, 0)).toBe(17.5)
    expect(snapBackoff(8, 10, bells, 0)).toBe(10)
    expect(snapBackoff(18, 22.5, 2.5, 20)).toBe(20)

    let st = { unit: 'kg', plates: { kg: { 5: 6, _ts: 1 } } }
    expect(snapBackoff(72, 80, backoffGrid(st, { id: BENCH }), 20)).toBe(70)
    st = { unit: 'kg', plates: withPlatePairs(st, 1.25, 2, 2) }
    expect(snapBackoff(72, 80, backoffGrid(st, { id: BENCH }), 20)).toBe(72.5)

    // Topped-out custom cable stack holds at heaviest pin
    const stackSt = { unit: 'kg', effort: 'rpe', workouts: [], exWeights: {} }
    stackSt.stackWeights = withStack(stackSt, CABLE_ROW, [5, 11.3, 18.1, 24.9, 31.8])
    const cfg = { id: CABLE_ROW, sets: 3, reps: 10, repsMin: 7, weight: 31.8, prog: 'rpt' }
    const r = rig(cfg, { stackWeights: stackSt.stackWeights })
    r.train((s, k) => (k === 0 ? { r: 10, rpe: 8 } : { r: 8 }))
    const next = nextPrescription(r.st, cfg, r.routine)
    expect(next).toMatchObject({ kind: 'hold', weight: 31.8, reps: 10 })
    expect(next.why[0]).toMatch(/whole stack/)
  })

  it('matches Lat Pulldown reactive 8-9-10 flow: stays at 60 kg after 60x8 @ RPE 8, then drops to 55 kg if Set 2 hits 60x6 @ RPE 9', () => {
    const spec = { ramp: '8-9-10', repsMin: 6, reps: 10, grid: 5, floor: 5 }
    let rows = [
      { w: 60, r: 8, rpe: 8, done: true },
      { w: 60, r: 8, done: false },
      { w: 60, r: 8, done: false },
    ]
    // Set 1: 60 x 8 @ RPE 8 -> plenty of rep & RPE headroom -> Set 2 stays at 60 kg
    rows = applyReactiveRpt(rows, 0, spec)
    expect(rows.map(s => s.w)).toEqual([60, 60, 60])

    // Subcase A: Set 2 hits 60 x 7 @ RPE 9 -> Set 3 stays at 60 kg (for RPE 10)
    const rowsStay = applyReactiveRpt(
      [rows[0], { w: 60, r: 7, rpe: 9, done: true }, rows[2]],
      1,
      spec
    )
    expect(rowsStay.map(s => s.w)).toEqual([60, 60, 60])

    // Subcase B: Set 2 lands on the floor (60 x 6 @ RPE 9) -> Set 3 drops to 55 kg on the 5 kg stack!
    const rowsDrop = applyReactiveRpt(
      [rows[0], { w: 60, r: 6, rpe: 9, done: true }, rows[2]],
      1,
      spec
    )
    expect(rowsDrop.map(s => s.w)).toEqual([60, 60, 55])
  })

  it('matches real-world T-Bar Row sessions (16 Nov, 19 Nov, 23 Nov, 27 Nov) and keeps Pull vs Upper tracks isolated', () => {
    const rowSpec = { ramp: '8-9-10', repsMin: 6, reps: 10, grid: 2.5, floor: 5 }

    // 16 Nov Pull: Set 1 25x8 @ RPE 9 -> stays 25 kg on Set 2; Set 2 25x7 @ RPE 9.5 -> drops Set 3
    let nov16 = applyReactiveRpt(
      [{ w: 25, r: 8, rpe: 9, done: true }, { w: 25, r: 8, done: false }, { w: 25, r: 8, done: false }],
      0,
      rowSpec
    )
    expect(nov16[1].w).toBe(25)
    nov16 = applyReactiveRpt([nov16[0], { w: 25, r: 7, rpe: 9.5, done: true }, nov16[2]], 1, rowSpec)
    expect(nov16[2].w).toBeLessThan(25)

    // 19 Nov Upper: Set 1 25x6 @ RPE 8 (on the floor of 6-10) -> Set 2 drops immediately despite RPE 8
    const nov19 = applyReactiveRpt(
      [{ w: 25, r: 6, rpe: 8, done: true }, { w: 25, r: 8, done: false }, { w: 25, r: 8, done: false }],
      0,
      rowSpec
    )
    expect(nov19[1].w).toBeLessThan(25)

    // 23 Nov Pull: Set 1 25x7 @ RPE 9 -> drops to 22.5 kg; Set 2 22.5x8 @ RPE 9 -> Set 3 stays at 22.5 kg!
    let nov23 = applyReactiveRpt(
      [{ w: 25, r: 7, rpe: 9, done: true }, { w: 25, r: 8, done: false }, { w: 25, r: 8, done: false }],
      0,
      rowSpec
    )
    expect(nov23[1].w).toBe(22.5)
    nov23 = applyReactiveRpt([nov23[0], { w: 22.5, r: 8, rpe: 9, done: true }, nov23[2]], 1, rowSpec)
    expect(nov23[2].w).toBe(22.5)

    // 27 Nov Upper: Set 1 25x7 @ RPE 9.5 drops at least as much or deeper on fine 1.25 kg microplates
    const w90 = reactiveNextWeight({ w: 25, r: 7, rir: 1 }, { currentRir: 2, nextRir: 1, repsMin: 6, repsMax: 10, grid: 1.25, floor: 5 })
    const w95 = reactiveNextWeight({ w: 25, r: 7, rir: 0.5 }, { currentRir: 2, nextRir: 1, repsMin: 6, repsMax: 10, grid: 1.25, floor: 5 })
    expect(w95).toBeLessThanOrEqual(w90)
    expect(w95).toBe(22.5)
    expect(w90).toBe(23.75)

    // Pull vs Upper routine isolation: non-linear dip on Pull (8 -> 7) never collides with Upper (6 -> 7)
    const tbarCfg = { id: CABLE_ROW, sets: 3, reps: 8, repsMin: 6, weight: 25, inc: 1.25, prog: 'rpt' }
    const pullR = { id: 'r-pull', name: 'Pull', ex: [tbarCfg] }
    const upperR = { id: 'r-upper', name: 'Upper', ex: [tbarCfg] }
    const S = {
      unit: 'kg', effort: 'rpe', exWeights: {}, routines: [pullR, upperR],
      workouts: [
        { id: 'w1', d: '2026-11-16', routineId: 'r-pull', routineIds: ['r-pull'], entries: [{ id: CABLE_ROW, rid: 'r-pull', planned: { sets: 3, reps: 8, repsMin: 6, weight: 25 }, target: { ...tbarCfg }, sets: [{ w: 25, r: 8, rpe: 9.5, done: true }, { w: 25, r: 7, rpe: 9.5, done: true }, { w: 20, r: 8, rpe: 10, done: true }] }] },
        { id: 'w2', d: '2026-11-19', routineId: 'r-upper', routineIds: ['r-upper'], entries: [{ id: CABLE_ROW, rid: 'r-upper', planned: { sets: 3, reps: 8, repsMin: 6, weight: 25 }, target: { ...tbarCfg }, sets: [{ w: 25, r: 6, rpe: 8, done: true }, { w: 21.25, r: 7, rpe: 9, done: true }, { w: 20, r: 8, rpe: 10, done: true }] }] },
        { id: 'w3', d: '2026-11-23', routineId: 'r-pull', routineIds: ['r-pull'], entries: [{ id: CABLE_ROW, rid: 'r-pull', planned: { sets: 3, reps: 8, repsMin: 6, weight: 25 }, target: { ...tbarCfg }, sets: [{ w: 25, r: 7, rpe: 9, done: true }, { w: 22.5, r: 8, rpe: 9, done: true }, { w: 22.5, r: 7, rpe: 10, done: true }] }] },
        { id: 'w4', d: '2026-11-27', routineId: 'r-upper', routineIds: ['r-upper'], entries: [{ id: CABLE_ROW, rid: 'r-upper', planned: { sets: 3, reps: 8, repsMin: 6, weight: 25 }, target: { ...tbarCfg }, sets: [{ w: 25, r: 6, rpe: 9.5, done: true }, { w: 21.25, r: 8, rpe: 9, done: true }, { w: 20, r: 7, rpe: 10, done: true }] }] },
      ],
    }
    expect(nextPrescription(S, tbarCfg, pullR)).toMatchObject({ kind: 'hold', weight: 25, reps: 8 })
    expect(nextPrescription(S, tbarCfg, upperR)).toMatchObject({ kind: 'hold', weight: 25, reps: 7 })
    expect(stallCount(sessionsFor(S, CABLE_ROW, tbarCfg, 'r-pull'), 'rpt', tbarCfg)).toBe(0)
    expect(stallCount(sessionsFor(S, CABLE_ROW, tbarCfg, 'r-upper'), 'rpt', tbarCfg)).toBe(0)
  })

  it('preserves manual weight overrides, stops at already-completed rows below, and adjusts unilateral limbs independently', () => {
    const spec = { ramp: '8-9-10', repsMin: 6, reps: 10, grid: 2.5, floor: 20 }
    // Editing Set 1 after Set 2 is already done must not overwrite Set 2 OR Set 3 (which belongs to Set 2)
    const withDoneSet2 = [
      { w: 80, r: 9, rpe: 8, done: true },
      { w: 80, r: 6, rpe: 9.5, done: true },
      { w: 72.5, r: 8, done: false },
    ]
    expect(applyReactiveRpt(withDoneSet2, 0, spec).map(s => s.w)).toEqual([80, 80, 72.5])

    // Manual override on Set 2 stays put while Set 3 still adjusts from Set 1 until Set 2 is completed
    const withManualSet2 = [
      { w: 80, r: 6, rpe: 9.5, done: true },
      { w: 77.5, r: 8, done: false, weightOrigin: WEIGHT_ORIGIN_MANUAL },
      { w: 80, r: 8, done: false },
    ]
    const outManual = applyReactiveRpt(withManualSet2, 0, spec)
    expect(outManual[1].w).toBe(77.5)
    expect(outManual[2].w).toBeLessThan(80)

    // Unilateral per-side: Left hits 20x6 @ RPE 9.5 (drops to 18), Right hits 20x8 @ RPE 8 (stays 20)
    const sideSpec = { ramp: '8-9-10', repsMin: 12, reps: 20, grid: [14, 16, 18, 20, 22], floor: 0 }
    let s1 = makeSideSet({ w: 20, r: 16 })
    s1 = toggleSide(setSideField(setSideField(s1, 'L', 'r', 6), 'L', 'rpe', 9.5), 'L')
    s1 = toggleSide(setSideField(setSideField(s1, 'R', 'r', 8), 'R', 'rpe', 8), 'R')
    const s2 = makeSideSet({ w: 20, r: 16 })
    const sideOut = applyReactiveRpt([s1, s2], 0, sideSpec)
    expect(sideOut[1].sides.L.w).toBeLessThan(20)
    expect(sideOut[1].sides.R.w).toBe(20)
  })
})

describe('First session & warm-up ramping', () => {
  it('opens all working sets at the top weight with `target.rpt` metadata and ramps warm-ups to Set 1', () => {
    const r = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, warmupSets: 2, prog: 'rpt' })
    const entry = r.open()
    expect(entry.plan).toMatchObject({ policy: 'rpt', kind: 'first', weight: 80, reps: 7 })
    expect(entry.target).toMatchObject({ weight: 80, reps: 7, rpt: { ramp: '8-9-10', repsMin: 7, reps: 10 } })
    expect(entry.sets.filter(isWarmupRow).map(s => [s.w, s.r])).toEqual([[40, 7], [60, 7]])
    expect(work(entry.sets).map(s => [s.w, s.r])).toEqual([[80, 7], [80, 7], [80, 7]])
  })

  it('prefers confirmed working weight over cfg.weight on session 1, and leaves 0 kg open when unset', () => {
    const rConf = rig(
      { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 60, prog: 'rpt' },
      { exWeights: { [BENCH]: { w: 100, d: '2026-04-01' } } }
    )
    expect(work(rConf.open().sets).map(s => s.w)).toEqual([100, 100, 100])

    const rZero = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 0, prog: 'rpt' })
    const zeroEntry = rZero.open()
    expect(work(zeroEntry.sets).map(s => [s.w, s.r])).toEqual([[0, 7], [0, 7], [0, 7]])
  })
})

describe('Between-session progression & plateau awareness driven strictly by Set 1', () => {
  const cfg = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, inc: 2.5, warmupSets: 1, mode: 'reps', prog: 'rpt' }

  it('levels up when Set 1 hits top of range within effort cap, even when later sets drop load or miss reps', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { r: 10, rpe: 8.5 } : k === 1 ? { w: 72.5, r: 5 } : { done: false }))
    const e2 = r.open()
    expect(e2.plan).toMatchObject({ policy: 'rpt', kind: 'up', weight: 82.5, reps: 7 })
    expect(work(e2.sets).map(s => [s.w, s.r])).toEqual([[82.5, 7], [82.5, 7], [82.5, 7]])
  })

  it('falls back to rep-only progression when effort tracking is off, topMinRir is 0, or Set 1 is unrated', () => {
    const rUnrated = rig(cfg)
    rUnrated.train((s, k) => (k === 0 ? { r: 10 } : { r: 8 }))
    expect(rUnrated.open().plan).toMatchObject({ kind: 'up', weight: 82.5, reps: 7 })

    const rNone = rig(cfg, { effort: 'none' })
    rNone.train((s, k) => (k === 0 ? { r: 10, rpe: 10 } : { r: 8 }))
    expect(rNone.open().plan).toMatchObject({ kind: 'up', weight: 82.5, reps: 7 })

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
    expect(pRpe).toMatchObject({ kind: 'hold', weight: 80, reps: 10 })
    expect(pRpe.why[0]).toContain('RPE')
    expect(stallCount(sessionsFor(rRpe.st, BENCH, cfg, rRpe.routine.id), 'rpt', cfg)).toBe(0)

    const rRir = rig({ ...cfg, topMinRir: 2 }, { effort: 'rir' })
    rRir.train((s, k) => (k === 0 ? { r: 10, rir: 1 } : { r: 8 }))
    const pRir = rRir.open().plan
    expect(pRir).toMatchObject({ kind: 'hold', weight: 80, reps: 10 })
    expect(pRir.why).toEqual(['Top set hit {0} reps with {1} RIR (need {2}+ RIR). Hold {3} {4} until you have more in reserve.', 10, 1, 2, 80, 'kg'])
  })

  it('surfaces plateau guidance after 4+ stagnant in-range sessions at the same weight, unless effort got easier', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { r: 8, rpe: 9 } : { r: 8 }))
    r.train((s, k) => (k === 0 ? { r: 7, rpe: 9 } : { r: 8 }))
    r.train((s, k) => (k === 0 ? { r: 8, rpe: 9 } : { r: 8 }))
    // After 3 sessions, still standard encouragement
    expect(r.open().plan.why[0]).toBe('Top set hit {0} reps. Same weight, aim for {1} reps next.')

    // 4th stagnant session at 80 kg (7 reps @ RPE 9.5 <= prior best) surfaces plateau guidance without deloading
    r.train((s, k) => (k === 0 ? { r: 7, rpe: 9.5 } : { r: 8 }))
    const flatPlan = r.open().plan
    expect(flatPlan).toMatchObject({ kind: 'hold', weight: 80, reps: 8 })
    expect(flatPlan.why[0]).toContain('micro-load if progress feels flat')

    // Hitting 8 reps @ RPE 8 (cleaner RIR than prior 8 @ RPE 9!) counts as real progress and clears the flat note
    r.train((s, k) => (k === 0 ? { r: 8, rpe: 8 } : { r: 8 }))
    expect(r.open().plan.why[0]).toBe('Top set hit {0} reps. Same weight, aim for {1} reps next.')
  })

  it('triggers an Epley deload after 3 Set 1 misses below repsMin (ignoring excluded sessions)', () => {
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { r: 6 } : { r: 10 }))
    r.train((s, k) => (k === 0 ? { r: 5 } : { r: 10 }))
    r.train(() => ({ r: 3 }), { excludeFromProgression: true })
    expect(r.open().plan.kind).toBe('hold')
    r.train((s, k) => (k === 0 ? { r: 5 } : { r: 10 }))
    const deloaded = r.open()
    expect(deloaded.plan.kind).toBe('deload')
    expect(deloaded.plan.weight).toBeLessThan(80)
    expect(work(deloaded.sets).map(s => s.w)).toEqual([deloaded.plan.weight, deloaded.plan.weight, deloaded.plan.weight])
  })

  it('supports unilateral per-side sets (`side: true`) with even rep steps', () => {
    const uCfg = { id: DB_BENCH, sets: 3, reps: 20, repsMin: 14, weight: 30, inc: 2, side: true, prog: 'rpt' }
    const r = rig(uCfg)
    const e1 = r.open()
    const w1 = work(e1.sets)
    expect(w1.every(isSideSet)).toBe(true)
    expect(w1.map(s => [s.sides.L.w, s.sides.R.w, s.r])).toEqual([[30, 30, 14], [30, 30, 14], [30, 30, 14]])

    const [built] = buildSessionEntries(r.st, r.routine)
    const sets = built.sets.map((s, idx) => {
      if (idx === 0) {
        let row = setSideField(s, 'L', 'r', 10)
        row = setSideField(row, 'R', 'r', 10)
        row = setSideField(row, 'L', 'rpe', 8)
        row = setSideField(row, 'R', 'rpe', 8.5)
        return toggleSide(toggleSide(row, 'L'), 'R')
      }
      return toggleSide(toggleSide(s, 'L'), 'R')
    })
    const saved = buildCompletedWorkout({
      id: 'wu1', d: '2026-04-01', start: 1000, routineId: r.routine.id, routineIds: [r.routine.id], name: 'U',
      entries: [{ ...built, rid: r.routine.id, sets }],
    }, { end: 2000 })
    r.st = { ...r.st, workouts: [saved] }
    expect(r.open().plan).toMatchObject({ kind: 'up', weight: 32, reps: 14 })
  })
})

describe('Bodyweight (`0 kg`) inheritance guard, assisted lifts, and downstream contracts', () => {
  it('degrades cleanly to ordinary bodyweight rep climbing when inherited by a 0 kg bodyweight exercise', () => {
    const bwCfg = { id: PUSHUP, sets: 3, reps: 10, repsMax: 12, weight: 0, bodyweight: true }
    const r = rig(bwCfg, { routine: { prog: 'rpt' } })
    const e1 = r.open()
    expect(e1.target.rpt).toBeUndefined()
    r.train((s, k) => ({ r: k === 2 ? 8 : 10 }))
    expect(r.open().plan).toMatchObject({ policy: 'rpt', kind: 'hold', weight: 0, reps: 10 })
    r.train(() => ({ r: 10 }))
    expect(r.open().plan).toMatchObject({ policy: 'rpt', kind: 'up', weight: 0, reps: 11 })
  })

  it('handles weighted bodyweight and assisted machines cleanly', () => {
    const weightedPull = { id: PUSHUP, sets: 3, reps: 8, repsMin: 5, weight: 20, inc: 2.5, bodyweight: true, prog: 'rpt' }
    const r = rig(weightedPull)
    expect(work(r.open().sets).map(s => [s.w, s.r])).toEqual([[20, 5], [20, 5], [20, 5]])
    r.train((s, k) => (k === 0 ? { r: 8, rpe: 8 } : { r: 6 }))
    expect(work(r.open().sets).map(s => [s.w, s.r])).toEqual([[22.5, 5], [22.5, 5], [22.5, 5]])

    const aCfg = { id: ASSISTED_DIP, sets: 3, reps: 10, repsMin: 8, weight: 40, inc: 5 }
    const ra = rig(aCfg, { routine: { prog: 'rpt' } })
    ra.train((s, k) => (k === 0 ? { r: 10, rpe: 8 } : { r: 7 }))
    expect(ra.open().plan).toMatchObject({ kind: 'up', weight: 35, reps: 8 })
  })

  it('finishCompare, plan-share (`rptRamp` + `topMinRir`), units, and session-routines round-trip cleanly', () => {
    const cfg = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, inc: 2.5, prog: 'rpt', rptRamp: '9-9-10', topMinRir: 0 }
    const r = rig(cfg)
    const saved = r.train((s, k) => (k === 0 ? { r: 10, rpe: 10 } : { r: 8 }))
    expect(finishCompare(r.st, saved)[0].next).toEqual({ w: 82.5, r: 7, sets: 3, kind: 'up' })

    const defaultEx = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt', rptRamp: '8-9-10', topMinRir: 1 }
    const bundle = buildPlanBundle({ unit: 'kg', week: { 1: ['r1'] }, routines: [{ id: 'r1', name: 'Push', ex: [cfg, defaultEx] }] }, 'RPT Plan')
    expect(bundle.routines[0].ex[0]).toMatchObject({ prog: 'rpt', rptRamp: '9-9-10', topMinRir: 0 })
    expect(bundle.routines[0].ex[1].rptRamp).toBeUndefined()
    expect(bundle.routines[0].ex[1].topMinRir).toBeUndefined()

    const raw = JSON.parse(JSON.stringify(bundle))
    raw.routines[0].ex[1].rptRamp = 'evil'
    raw.routines[0].ex[1].topMinRir = 'evil'
    const parsed = parsePlan(JSON.stringify(raw), 'kg')
    expect(parsed.routines[0].ex[0]).toMatchObject({ prog: 'rpt', rptRamp: '9-9-10', topMinRir: 0 })
    expect(parsed.routines[0].ex[1].rptRamp).toBeUndefined()
    expect(parsed.routines[0].ex[1].topMinRir).toBeUndefined()

    const dest = { unit: 'kg', routines: [], week: {}, customEx: [] }
    mergePlan(dest, parsed, { schedule: true })
    expect(dest.routines[0].ex[0]).toMatchObject({ prog: 'rpt', rptRamp: '9-9-10', topMinRir: 0 })

    // Legacy rowWeights on old saved entries still convert across profile unit switches
    const legacyState = {
      unit: 'kg',
      workouts: [{ id: 'lw1', d: '2026-04-01', entries: [{ id: BENCH, target: { weight: 80, rowWeights: [80, 72.5, 72.5] }, sets: [{ w: 80, r: 8, done: true }] }] }],
    }
    expect(convertStateUnit(legacyState, 'lb').workouts[0].entries[0].target.rowWeights).toEqual([176.5, 160, 160])

    // plannedConfigOf & routineFromSession strip session-only `rpt` metadata
    expect(plannedConfigOf(r.open()).rpt).toBeUndefined()
    const copied = routineFromSession(saved, 'Copied RPT', r.st.routines)
    expect(copied.ex[0].rpt).toBeUndefined()
    expect(copied.ex[0].weight).toBe(80)
  })
})

describe('Review follow-up regressions (Items 1–4 & preserved invariants)', () => {
  it('Item 1: counts misses and deloads to bottom of range when repsMin is omitted on config', () => {
    const cfg = { id: BENCH, sets: 3, reps: 10, weight: 80, prog: 'rpt' }
    const r = rig(cfg)
    r.train((s, k) => ({ r: k === 0 ? 6 : 8 }))
    expect(r.open().plan.why.slice(1)).toEqual([8, 2, 3])
    r.train((s, k) => ({ r: k === 0 ? 7 : 8 }))
    expect(r.open().plan.why.slice(1)).toEqual([8, 1, 3])
    r.train((s, k) => ({ r: k === 0 ? 6 : 8 }))
    const after3 = r.open()
    expect(after3.plan.kind).toBe('deload')
    expect(after3.plan.reps).toBe(8)
  })

  it('Item 2: never lets Set 2 stand in for an unticked Set 1 (bar limit, unprescribed weight, heavier Set 2, 3x skip, half-ticked side)', () => {
    const barRig = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 20, prog: 'rpt' })
    barRig.train((s, k) => (k === 0 ? { done: false } : { r: 10, rpe: 7 }))
    const barNext = barRig.open()
    expect(barNext.plan).toMatchObject({ kind: 'hold', weight: 20, reps: 7 })
    expect(barNext.plan.why[0]).not.toContain('missed')

    const skipRig = rig({ id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt' })
    skipRig.train((s, k) => (k === 0 ? { done: false } : { w: 85, r: 10, rpe: 7 }))
    skipRig.train((s, k) => (k === 0 ? { done: false } : { r: 10, rpe: 7 }))
    skipRig.train((s, k) => (k === 0 ? { done: false } : { r: 10, rpe: 7 }))
    expect(skipRig.open().plan.kind).toBe('deload')

    const sideRig = rig({ id: DB_BENCH, sets: 2, reps: 20, repsMin: 14, weight: 30, inc: 2, side: true, prog: 'rpt' })
    const [built] = buildSessionEntries(sideRig.st, sideRig.routine)
    const partialSets = [
      toggleSide(setSideField(built.sets[0], 'L', 'r', 10), 'L'),
      toggleSide(toggleSide(setSideField(setSideField(built.sets[1], 'L', 'r', 10), 'R', 'r', 10), 'L'), 'R'),
    ]
    const saved = buildCompletedWorkout({
      id: 'w-half', d: '2026-04-01', start: 1000, routineId: sideRig.routine.id, routineIds: [sideRig.routine.id], name: 'U',
      entries: [{ ...built, rid: sideRig.routine.id, sets: partialSets }],
    }, { end: 2000 })
    sideRig.st = { ...sideRig.st, workouts: [saved] }
    expect(sideRig.open().plan).toMatchObject({ kind: 'hold', weight: 30, reps: 14 })
  })

  it('Item 3: failed heavier attempt holds prescribed weight and continues stall streak; successful heavier attempts adopt lifted weight', () => {
    const cfg = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt' }
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { w: 80, r: 5 } : { r: 8 }))
    r.train((s, k) => (k === 0 ? { w: 90, r: 4 } : { r: 8 }))
    expect(r.open().plan).toMatchObject({ kind: 'hold', weight: 80, reps: 7 })
    expect(stallCount(sessionsFor(r.st, BENCH, cfg, r.routine.id), 'rpt', cfg)).toBe(2)
    r.train((s, k) => (k === 0 ? { w: 80, r: 6 } : { r: 8 }))
    expect(r.open().plan.kind).toBe('deload')

    const rUp = rig(cfg)
    rUp.train((s, k) => (k === 0 ? { w: 90, r: 10, rpe: 8 } : { r: 8 }))
    expect(rUp.open().plan).toMatchObject({ kind: 'up', weight: 92.5, reps: 7 })
  })

  it('Item 4: running programmes keep `target.rpt` reactive metadata across %1RM, RPE-only, deload weeks, and pinned units', () => {
    const cfg = { id: BENCH, sets: 3, reps: 10, repsMin: 7, weight: 80, prog: 'rpt', rptRamp: '9-9-10' }
    const r = rig(cfg)
    r.train((s, k) => (k === 0 ? { w: 100, r: 5, rpe: 8 } : { w: 80, r: 8 }))
    r.st = {
      ...r.st,
      programmes: {
        p1: {
          id: 'p1', name: 'Block', at: 1, days: { 1: [r.routine.id] },
          weeks: [{ t: { [BENCH]: { pct: 75, rpe: 8 } } }, { rpe: 8.5 }, { deload: true }],
        },
      },
    }
    startProgramme(r.st, 'p1', '2026-05-04', 1000)

    r.st.active = { id: 'pw1', d: '2026-05-04' }
    const w1 = buildSessionEntries(r.st, r.routine)[0]
    expect(w1.plan.kind).toBe('programme')
    expect(w1.target.rpt).toEqual({ ramp: '9-9-10', repsMin: 7, reps: 10 })
    expect(work(w1.sets).map(s => s.w)).toEqual([87.5, 87.5, 87.5])

    r.st.active = { id: 'pw3', d: '2026-05-18' }
    const w3 = buildSessionEntries(r.st, r.routine)[0]
    expect(w3.noProg).toBe(true)
    expect(w3.target.rpt).toEqual({ ramp: '9-9-10', repsMin: 7, reps: 10 })
  })
})
