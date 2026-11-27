// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { EXDB, isAssisted } from './lib/exercises.js'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI } from './components/ui.jsx'
import { exConfigSheet } from './sheets.jsx'
import Workout from './views/Workout.jsx'
import RoutineEdit from './views/RoutineEdit.jsx'
import { buildPlannedEntry } from './lib/session-start.js'
import { withExUnit, shownWeight } from './lib/ex-unit.js'
import { isWarmupRow } from './lib/workout-model.js'

vi.mock('./lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn(), restOver: vi.fn() }))
vi.mock('./lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))

const BENCH = EXDB.find(e => e.id === '0025')
const CABLE = EXDB.find(e => e.eq === 'cable' && !isAssisted(e.id))
const PUSHUP = EXDB.find(e => e.id === '0662')
const ASSISTED_DIP = EXDB.find(e => isAssisted(e.id))

const clone = v => JSON.parse(JSON.stringify(v))
const mounted = []

function mountSheet(sheet) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push([root, host])
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}

function openConfig(ex, cfg = {}, { onSave = vi.fn(), routine = { id: 'r1', name: 'Push' } } = {}) {
  exConfigSheet(ex, { sets: 3, reps: 10, repsMin: 6, weight: 80, mode: 'reps', ...cfg }, onSave, null, routine)
  const host = mountSheet(useUI.getState().sheets.at(-1))
  return { host, onSave }
}

const findRow = (host, title) =>
  [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)

const stepperByLabel = (host, label) =>
  [...host.querySelectorAll('.stp-w')].find(w => w.querySelector('.stp-l')?.textContent === label)

function pickSelectOption(host, rowTitle, optionLabel) {
  const row = findRow(host, rowTitle)
  expect(row, `SelectRow "${rowTitle}"`).toBeTruthy()
  act(() => row.click())
  const pickerHost = mountSheet(useUI.getState().sheets.at(-1))
  const opt = [...pickerHost.querySelectorAll('.lrow')].find(
    r => r.querySelector('.lrow-t')?.textContent === optionLabel
  )
  expect(opt, `Option "${optionLabel}" in "${rowTitle}"`).toBeTruthy()
  act(() => opt.click())
  return pickerHost
}

describe('ExConfig & ProgressionFields for per-set reactive RPE ramp (`rpt`)', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    bindUI(useUI)
    useUI.setState({ sheets: [] })
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    useStore.setState({ S, user: null })
    document.body.innerHTML = ''
  })

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach(([root, host]) => {
        root.unmount()
        host.remove()
      })
    })
  })

  it('offers Top set & back-offs on loaded lifts, hides it on 0 kg bodyweight and assisted machines', () => {
    const { host: benchHost } = openConfig(BENCH, {})
    act(() => findRow(benchHost, 'Rule').click())
    const benchPicker = mountSheet(useUI.getState().sheets.at(-1))
    expect(findRow(benchPicker, 'Top set & back-offs')).toBeTruthy()

    const { host: bwHost } = openConfig(PUSHUP, { weight: 0, bodyweight: true, repsMin: undefined })
    act(() => findRow(bwHost, 'Rule').click())
    const bwPicker = mountSheet(useUI.getState().sheets.at(-1))
    expect(findRow(bwPicker, 'Top set & back-offs')).toBeUndefined()

    const { host: assistedHost } = openConfig(ASSISTED_DIP, { weight: 35 })
    act(() => findRow(assistedHost, 'Rule').click())
    const assistedPicker = mountSheet(useUI.getState().sheets.at(-1))
    expect(findRow(assistedPicker, 'Top set & back-offs')).toBeUndefined()
  })

  it('ties per-set RPE steppers dynamically to Sets (2 sets -> 9, 10; 3 sets -> 8, 9, 10; 4 sets -> 8, 9, 9, 10)', () => {
    const { host } = openConfig(BENCH, { prog: 'rpt', sets: 2, weight: 80 })
    expect(host.textContent).toContain('Target RPE per set')
    expect(stepperByLabel(host, 'Set 1')?.querySelector('input')?.value).toBe('9')
    expect(stepperByLabel(host, 'Set 2')?.querySelector('input')?.value).toBe('10')
    expect(stepperByLabel(host, 'Set 3')).toBeUndefined()

    // Tap + on Sets twice (2 -> 3 -> 4) -> Set 3 & Set 4 steppers appear dynamically!
    const setsPlus = stepperByLabel(host, 'Sets').querySelector('[aria-label*=": Increase"]')
    act(() => setsPlus.click())
    expect([1, 2, 3].map(n => stepperByLabel(host, `Set ${n}`)?.querySelector('input')?.value)).toEqual(['8', '9', '10'])

    act(() => setsPlus.click())
    expect([1, 2, 3, 4].map(n => stepperByLabel(host, `Set ${n}`)?.querySelector('input')?.value)).toEqual(['8', '9', '9', '10'])
  })

  it('adapts per-set steppers and Effort gate labels to RIR vs RPE and omits default rptRir on Save', () => {
    const saveBtn = h => [...h.querySelectorAll('button')].find(b => b.textContent === 'Save')

    // 2-set default (9 -> 10) omits rptRir on Save
    const def2 = openConfig(BENCH, { prog: 'rpt', sets: 2 })
    act(() => saveBtn(def2.host).click())
    expect(def2.onSave.mock.calls[0][0].rptRir).toBeUndefined()

    // Hack Squat 3 sets customized to 8 -> 9 -> 9 (tap Decrease twice on Set 3: 10 -> 9.5 -> 9) saves rptRir: [2, 1, 1]
    const hack = openConfig(BENCH, { prog: 'rpt', sets: 3 })
    const set3Minus = stepperByLabel(hack.host, 'Set 3').querySelector('[aria-label*=": Decrease"]')
    act(() => set3Minus.click())
    act(() => set3Minus.click())
    expect(stepperByLabel(hack.host, 'Set 3').querySelector('input').value).toBe('9')
    pickSelectOption(hack.host, 'Effort gate', 'Off')
    act(() => saveBtn(hack.host).click())
    expect(hack.onSave.mock.calls[0][0]).toMatchObject({ prog: 'rpt', rptRir: [2, 1, 1], topMinRir: 0 })

    // RIR scale shows 2, 1, 1 for rptRir: [2, 1, 1]
    act(() => useStore.setState(s => ({ S: { ...s.S, effort: 'rir' } })))
    const rirHost = openConfig(BENCH, { prog: 'rpt', sets: 3, rptRir: [2, 1, 1], topMinRir: 2 }).host
    expect(rirHost.textContent).toContain('Target RIR per set')
    expect([1, 2, 3].map(n => stepperByLabel(rirHost, `Set ${n}`)?.querySelector('input')?.value)).toEqual(['2', '1', '1'])
    expect(findRow(rirHost, 'Effort gate')?.querySelector('.lrow-v')?.textContent).toBe('2+ RIR in reserve')
  })

  it('displays live progressed weight (65 kg instead of Day-1 55 kg) on RoutineEdit rows and in ExConfig without resetting baseline', () => {
    const slot = { id: CABLE.id, sets: 3, reps: 10, repsMin: 6, weight: 55, inc: 5, mode: 'reps', prog: 'rpt' }
    const routine = { id: 'r-pull', name: 'Pull', emoji: 'dumbbell', ex: [slot] }
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    S.routines = [routine]
    S.workouts = [{
      id: 'w-prev', d: '2026-10-01', routineId: 'r-pull', routineIds: ['r-pull'], name: 'Pull',
      entries: [{
        id: CABLE.id, rid: 'r-pull',
        planned: { sets: 3, reps: 10, repsMin: 6, weight: 55 },
        target: { ...slot, weight: 60 },
        sets: [{ w: 60, r: 10, rpe: 8, done: true }, { w: 60, r: 8, rpe: 9, done: true }, { w: 55, r: 8, rpe: 10, done: true }],
      }],
    }]
    useStore.setState({ S, user: null })

    const rHost = document.createElement('div')
    document.body.appendChild(rHost)
    const rRoot = createRoot(rHost)
    mounted.push([rRoot, rHost])
    act(() => rRoot.render(
      <MemoryRouter initialEntries={['/plan/r/r-pull']}>
        <Routes><Route path="/plan/r/:id" element={<RoutineEdit />} /></Routes>
      </MemoryRouter>
    ))
    // RoutineEdit row shows 65 kg (next progressed top weight), NOT the stale 55 kg!
    expect(rHost.querySelector('[data-routine-row] .ss')?.textContent).toContain('3 × 6–10 · 65 kg')

    // Tapping the exercise opens ExConfig showing 65 kg, and saving an RPE edit preserves the 55 kg baseline!
    act(() => rHost.querySelector('[data-routine-row] .tap-main').click())
    const cfgHost = mountSheet(useUI.getState().sheets.at(-1))
    expect(stepperByLabel(cfgHost, 'Weight (kg)')?.querySelector('input')?.value).toBe('65')
    expect(cfgHost.textContent).toContain('Sets open at 65 kg')
    const set3Minus = stepperByLabel(cfgHost, 'Set 3').querySelector('[aria-label*=": Decrease"]')
    act(() => set3Minus.click())
    act(() => set3Minus.click())
    act(() => [...cfgHost.querySelectorAll('button')].find(b => b.textContent === 'Save').click())

    const savedSlot = useStore.getState().S.routines[0].ex[0]
    expect(savedSlot.rptRir).toEqual([2, 1, 1])
    expect(savedSlot.weight).toBe(55) // baseline untouched so rep progression is not reset!
  })
})

describe('Live Workout reactive RPT set adjustments (custom RPEs + pinned units)', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    bindUI(useUI)
    useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null })
    document.body.innerHTML = ''
  })

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach(([root, host]) => {
        root.unmount()
        host.remove()
      })
    })
  })

  function mountWorkout(entries, patch = {}) {
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    S.workoutView = 'list'
    Object.assign(S, patch)
    S.active = {
      id: 'w-rpt-live', d: '2026-10-09', start: Date.now(), routineId: 'r1',
      name: 'Pull', bw: null, cur: 0, entries, workoutView: 'list',
    }
    useStore.setState({ S, user: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push([root, host])
    act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
    return host
  }

  const weightInputs = host => [...host.querySelectorAll('.wl-unit .stp.w input')]
  const repInputs = host => [...host.querySelectorAll('.wl-unit .stp.r input')]
  const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set

  it('shows ~8 / ~9 / ~10 hints on open sets, keeps 60 kg after 60x8 @ RPE 8, and drops Set 3 to 55 kg after 60x6 @ RPE 9', () => {
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    const entry = {
      id: CABLE.id,
      ...buildPlannedEntry(
        S,
        { id: CABLE.id, sets: 3, reps: 10, repsMin: 6, weight: 60, inc: 5, prog: 'rpt' },
        { id: 'r1', name: 'Pull' }
      ),
    }
    const host = mountWorkout([entry])
    expect(weightInputs(host).map(el => el.value)).toEqual(['60', '60', '60'])
    expect([...host.querySelectorAll('.effcell.is-empty')].map(el => el.textContent)).toEqual(['~8', '~9', '~10'])

    act(() => {
      const r0 = repInputs(host)[0]
      setVal.call(r0, '8')
      r0.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[0].click())
    const effSheet1 = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...effSheet1.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Two more reps')).click())
    expect(weightInputs(host).map(el => el.value)).toEqual(['60', '60', '60'])

    act(() => {
      const r1 = repInputs(host)[1]
      setVal.call(r1, '6')
      r1.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[0].click())
    const effSheet2 = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...effSheet2.querySelectorAll('.menu-item')].find(b => b.textContent.includes('One more rep in the tank')).click())
    expect(weightInputs(host).map(el => el.value)).toEqual(['60', '60', '55'])
  })

  it('reactively drops onto the lb grid when an RPT exercise is pinned to lb on a kg profile', () => {
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    S.exUnit = withExUnit({}, BENCH.id, 'lb', 1)
    const w185kg = Math.round(185 * 0.45359237 * 1e4) / 1e4
    const entry = {
      id: BENCH.id,
      ...buildPlannedEntry(
        S,
        { id: BENCH.id, sets: 2, reps: 10, repsMin: 6, weight: w185kg, prog: 'rpt', rptRir: [0, 0] },
        { id: 'r1', name: 'Push' }
      ),
    }
    const host = mountWorkout([entry], { exUnit: S.exUnit })
    expect([...host.querySelectorAll('.effcell.is-empty')].map(el => el.textContent)).toEqual(['~10', '~10'])

    act(() => {
      const r0 = repInputs(host)[0]
      setVal.call(r0, '6')
      r0.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[0].click())
    const effSheet = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...effSheet.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Nothing left')).click())

    const liveS = useStore.getState().S
    const lbWeights = liveS.active.entries[0].sets.filter(s => !isWarmupRow(s)).map(s => shownWeight(liveS, BENCH.id, s.w))
    expect(lbWeights[0]).toBe(185)
    expect(lbWeights[1]).toBeLessThan(185)
    expect(lbWeights[1] % 5).toBe(0)
  })

  it('preserves per-set RPE drafts when Sets steps down and back up, and shows effort-off guidance when effort is disabled', () => {
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'none'
    useStore.setState({ S, user: null })

    const { host, onSave } = openConfig(BENCH, { prog: 'rpt', sets: 4, weight: 100, rptRir: [2, 1.5, 1, 0.5] })
    // With effort='none', displayScale defaults to RIR ('2', '1.5', '1', '0.5') and shows the Settings hint
    expect(host.textContent).toContain('Turn RPE or RIR on in Settings')
    expect([1, 2, 3, 4].map(n => stepperByLabel(host, `Set ${n}`)?.querySelector('input')?.value)).toEqual(['2', '1.5', '1', '0.5'])

    // Step Sets down 4 -> 2, then back up 2 -> 4: Set 3 & Set 4 drafts (1, 0.5) survive!
    const setsMinus = stepperByLabel(host, 'Sets').querySelector('[aria-label*=": Decrease"]')
    const setsPlus = stepperByLabel(host, 'Sets').querySelector('[aria-label*=": Increase"]')
    act(() => setsMinus.click())
    act(() => setsMinus.click())
    expect(stepperByLabel(host, 'Set 3')).toBeUndefined()
    act(() => setsPlus.click())
    act(() => setsPlus.click())
    expect([1, 2, 3, 4].map(n => stepperByLabel(host, `Set ${n}`)?.querySelector('input')?.value)).toEqual(['2', '1.5', '1', '0.5'])

    act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Save').click())
    expect(onSave.mock.calls[0][0].rptRir).toEqual([2, 1.5, 1, 0.5])
  })

  it('handles untick/retick, editing a completed set, manual weight lock, warm-ups, failure toggle, and + Add set after all sets are done', () => {
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    const built = buildPlannedEntry(
      S,
      { id: CABLE.id, sets: 2, warmupSets: 1, reps: 10, repsMin: 6, weight: 60, inc: 5, prog: 'rpt' },
      { id: 'r1', name: 'Pull' }
    )
    const entry = { id: CABLE.id, rid: 'r1', ...built }
    const host = mountWorkout([entry])

    // Row 0 is warm-up (no ~RPE hint), Rows 1 & 2 are work sets (~9, ~10 for 2-set default)
    expect(weightInputs(host).map(el => el.value)).toEqual(['30', '60', '60'])
    expect([...host.querySelectorAll('.effcell.is-empty')].map(el => el.textContent)).toEqual(['RPE', '~9', '~10'])

    // Completing warm-up never touches work-set weights
    const checks = () => [...host.querySelectorAll('.wl-unit [role="checkbox"]')]
    act(() => checks()[0].click())
    expect(weightInputs(host).map(el => el.value)).toEqual(['30', '60', '60'])

    // Accidentally logging Set 1 as 60 x 5 @ Taken to failure drops Set 2 to 50/55, and UNTICKING Set 1 restores Set 2 to 60!
    act(() => {
      const r1 = repInputs(host)[1]
      setVal.call(r1, '5')
      r1.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.wl-unit .setrow .n')[1].click())
    const setMenu = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...setMenu.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Taken to failure')).click())
    act(() => checks()[1].click())
    expect(Number(weightInputs(host)[2].value)).toBeLessThan(60)

    // Untick Set 1 -> Set 2 restores back to 60 kg!
    act(() => checks()[1].click())
    expect(weightInputs(host)[2].value).toBe('60')

    // Clear failure on Set 1, log 60 x 8 @ RPE 9 -> Set 2 stays 60 kg
    act(() => host.querySelectorAll('.wl-unit .setrow .n')[1].click())
    const setMenu2 = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...setMenu2.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Taken to failure')).click())
    act(() => {
      const r1 = repInputs(host)[1]
      setVal.call(r1, '8')
      r1.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[1].click())
    const eff1 = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...eff1.querySelectorAll('.menu-item')].find(b => b.textContent.includes('One more rep in the tank')).click())
    expect(weightInputs(host).map(el => el.value)).toEqual(['30', '60', '60'])

    // Editing already-completed Set 1 down to 5 reps drops open Set 2 live, and editing back to 8 restores Set 2 to 60 kg!
    act(() => {
      const r1 = repInputs(host)[1]
      setVal.call(r1, '5')
      r1.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(Number(weightInputs(host)[2].value)).toBeLessThan(60)
    act(() => {
      const r1 = repInputs(host)[1]
      setVal.call(r1, '8')
      r1.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(weightInputs(host)[2].value).toBe('60')

    // Complete Set 2 as an all-out grinder (60 x 6 @ RPE 10), then tap "+ Add set":
    // Bonus Set 3 automatically opens at a reactively dropped weight (55 kg, NOT 60 kg) with hint ~10!
    act(() => {
      const r2 = repInputs(host)[2]
      setVal.call(r2, '6')
      r2.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[1].click())
    const eff2 = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...eff2.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Nothing left')).click())

    act(() => [...host.querySelectorAll('button.wk-add')].find(b => b.textContent.includes('Add set')).click())
    expect(weightInputs(host)).toHaveLength(4)
    expect(Number(weightInputs(host)[3].value)).toBe(55)
    expect([...host.querySelectorAll('.effcell.is-empty')].at(-1)?.textContent).toBe('~10')

    // Manually overriding Set 3's weight locks it against earlier set edits
    act(() => {
      const w3 = weightInputs(host)[3]
      setVal.call(w3, '52.5')
      w3.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      const r2 = repInputs(host)[2]
      setVal.call(r2, '10')
      r2.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(weightInputs(host)[3].value).toBe('52.5')
  })

  it('re-applies reactive RPT after mid-workout Exercise settings edits and never overwrites mid-workout or backfill weights with today projection', () => {
    const slot = { id: CABLE.id, sets: 3, reps: 10, repsMin: 6, weight: 55, inc: 5, mode: 'reps', prog: 'rpt' }
    const routine = { id: 'r1', name: 'Pull', emoji: 'dumbbell', ex: [slot] }
    const pastWorkout = {
      id: 'w-oct', d: '2026-10-15', routineId: 'r1', routineIds: ['r1'], name: 'Pull',
      entries: [{
        id: CABLE.id, rid: 'r1',
        planned: { sets: 3, reps: 10, repsMin: 6, weight: 55 },
        target: { ...slot, weight: 60 },
        sets: [{ w: 60, r: 10, rpe: 8, done: true }, { w: 60, r: 8, rpe: 9, done: true }, { w: 55, r: 8, rpe: 10, done: true }],
      }],
    }
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    S.routines = [routine]
    S.workouts = [pastWorkout]

    // 1) Live workout opens at 65 kg. Complete Set 1 as 65 x 6 @ RPE 9.5 -> Sets 2 & 3 drop to 60 kg.
    const liveEntry = { id: CABLE.id, rid: 'r1', ...buildPlannedEntry(S, slot, routine) }
    const host = mountWorkout([liveEntry], { routines: [routine], workouts: [pastWorkout] })
    expect(weightInputs(host).map(el => el.value)).toEqual(['65', '65', '65'])

    act(() => {
      const r0 = repInputs(host)[0]
      setVal.call(r0, '6')
      r0.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[0].click())
    const eff1 = mountSheet(useUI.getState().sheets.at(-1))
    act(() => [...eff1.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Nothing left')).click())
    expect(Number(weightInputs(host)[1].value)).toBeLessThan(65)

    // Open mid-workout Exercise settings (.progline), bump Sets 3 -> 4, and Save:
    // Set 1 stays done and open Sets 2..4 immediately adjust from Set 1 (NOT reset back to 65 kg!)
    act(() => host.querySelector('.progline').click())
    const midCfg = mountSheet(useUI.getState().sheets.at(-1))
    expect(stepperByLabel(midCfg, 'Weight (kg)')?.querySelector('input')?.value).toBe('65')
    act(() => stepperByLabel(midCfg, 'Sets').querySelector('[aria-label*=": Increase"]').click())
    act(() => [...midCfg.querySelectorAll('button')].find(b => b.textContent === 'Save').click())
    expect(weightInputs(host)).toHaveLength(4)
    expect(Number(weightInputs(host)[1].value)).toBeLessThan(65)
    expect(Number(weightInputs(host)[3].value)).toBeLessThan(65)

    // 2) Backfill workout dated BEFORE Oct 15 (Sept 1: 55 kg) keeps 55 kg in mid-workout settings, not Oct's 65 kg!
    const backfillS = clone(S)
    backfillS.active = { id: 'w-bf', d: '2026-09-01', backfill: true }
    const bfEntry = { id: CABLE.id, rid: 'r1', ...buildPlannedEntry({ ...backfillS, workouts: [] }, slot, routine) }
    act(() => useStore.setState({
      S: {
        ...backfillS,
        workoutView: 'list',
        active: { id: 'w-bf', d: '2026-09-01', start: 1000, backfill: true, routineId: 'r1', name: 'Pull', bw: null, cur: 0, entries: [bfEntry], workoutView: 'list' },
      },
      user: null,
    }))
    const bfHost = document.createElement('div')
    document.body.appendChild(bfHost)
    const bfRoot = createRoot(bfHost)
    mounted.push([bfRoot, bfHost])
    act(() => bfRoot.render(<MemoryRouter><Workout /></MemoryRouter>))
    act(() => bfHost.querySelector('.progline').click())
    const bfCfg = mountSheet(useUI.getState().sheets.at(-1))
    expect(stepperByLabel(bfCfg, 'Weight (kg)')?.querySelector('input')?.value).toBe('55')
  })
})
