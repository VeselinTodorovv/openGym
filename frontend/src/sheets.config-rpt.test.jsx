// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { EXDB, isAssisted } from './lib/exercises.js'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI } from './components/ui.jsx'
import { exConfigSheet } from './sheets.jsx'
import Workout from './views/Workout.jsx'
import { buildPlannedEntry } from './lib/session-start.js'
import { withExUnit, shownWeight } from './lib/ex-unit.js'
import { isWarmupRow } from './lib/workout-model.js'

vi.mock('./lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn(), restOver: vi.fn() }))
vi.mock('./lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))

const BENCH = EXDB.find(e => e.id === '0025')
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
  exConfigSheet(ex, { sets: 3, reps: 10, repsMin: 7, weight: 80, mode: 'reps', ...cfg }, onSave, null, routine)
  const host = mountSheet(useUI.getState().sheets.at(-1))
  return { host, onSave }
}

const findRow = (host, title) =>
  [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)

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

describe('ExConfig & ProgressionFields for Top set & back-offs (`rpt`)', () => {
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

    const { host: weightedBwHost } = openConfig(PUSHUP, { weight: 20, bodyweight: true })
    act(() => findRow(weightedBwHost, 'Rule').click())
    const weightedBwPicker = mountSheet(useUI.getState().sheets.at(-1))
    expect(findRow(weightedBwPicker, 'Top set & back-offs')).toBeTruthy()

    expect(ASSISTED_DIP).toBeTruthy()
    const { host: assistedHost } = openConfig(ASSISTED_DIP, { weight: 35 })
    act(() => findRow(assistedHost, 'Rule').click())
    const assistedPicker = mountSheet(useUI.getState().sheets.at(-1))
    expect(findRow(assistedPicker, 'Top set & back-offs')).toBeUndefined()
  })

  it('uses the 4-stepper row, hides the legacy Back-off sets switch, and previews opening weights', () => {
    const { host: linearHost } = openConfig(BENCH, { prog: 'linear', sets: 3, weight: 80 })
    expect(linearHost.querySelector('[role="switch"][aria-label="Back-off sets"]')).toBeTruthy()

    const { host } = openConfig(BENCH, { prog: 'rpt', sets: 3, weight: 80 })
    const stepRow = [...host.querySelectorAll('.cfgrow')].find(r =>
      r.querySelector('.stp-l')?.textContent.startsWith('Step')
    )
    expect(stepRow.querySelectorAll('.stp-w')).toHaveLength(4)
    expect(stepRow.classList.contains('cfgrow-4')).toBe(true)

    // Legacy flat-step Back-off sets switch is hidden when RPT is active (or inherited)
    expect(host.querySelector('[role="switch"][aria-label="Back-off sets"]')).toBeNull()
    const { host: inheritedHost } = openConfig(BENCH, { sets: 3, weight: 80 }, { routine: { id: 'r1', name: 'Push', prog: 'rpt' } })
    expect(inheritedHost.querySelector('[role="switch"][aria-label="Back-off sets"]')).toBeNull()

    expect(findRow(host, 'Back-off drop')?.querySelector('.lrow-v')?.textContent).toBe('10%')
    expect(findRow(host, 'Back-off sets')?.querySelector('.lrow-v')?.textContent).toBe('Same weight after set 1')
    expect(findRow(host, 'Effort gate')?.querySelector('.lrow-v')?.textContent).toBe('RPE 9 or easier')
    expect(host.textContent).toContain('Sets open at 80 → 72.5 → 72.5 kg. Set 1 drives progression; back-off sets follow it.')

    // Switching to step mode updates the live preview immediately
    pickSelectOption(host, 'Back-off sets', 'Step down each set')
    expect(host.textContent).toContain('Sets open at 80 → 72.5 → 65 kg. Set 1 drives progression; back-off sets follow it.')
  })

  it('adapts Effort gate labels to RPE vs RIR and shows a quiet note when effort tracking is off', () => {
    act(() => useStore.setState(s => ({ S: { ...s.S, effort: 'rir' } })))
    const { host: rirHost } = openConfig(BENCH, { prog: 'rpt', topMinRir: 2 })
    expect(findRow(rirHost, 'Effort gate')?.querySelector('.lrow-v')?.textContent).toBe('2+ RIR in reserve')
    expect(rirHost.textContent).not.toContain('Effort tracking is off')

    act(() => useStore.setState(s => ({ S: { ...s.S, effort: 'none' } })))
    const { host: offHost } = openConfig(BENCH, { prog: 'rpt', topMinRir: 1 })
    expect(offHost.textContent).toContain(
      'Effort tracking is off, so set 1 progresses on reps alone unless you turn RPE or RIR on in Settings.'
    )

    // Turning Effort gate Off hides the warning note
    pickSelectOption(offHost, 'Effort gate', 'Off')
    expect(offHost.textContent).not.toContain('Effort tracking is off')
  })

  it('omits default RPT settings on Save and persists non-default backoffPct, backoffMode, and topMinRir', () => {
    const defRun = openConfig(BENCH, { prog: 'rpt', backoffPct: 10, backoffMode: 'flat', topMinRir: 1 })
    const saveBtn = h => [...h.querySelectorAll('button')].find(b => b.textContent === 'Save')
    act(() => saveBtn(defRun.host).click())
    expect(defRun.onSave).toHaveBeenCalledTimes(1)
    const savedDefault = defRun.onSave.mock.calls[0][0]
    expect(savedDefault.prog).toBe('rpt')
    expect(savedDefault.backoffPct).toBeUndefined()
    expect(savedDefault.backoffMode).toBeUndefined()
    expect(savedDefault.topMinRir).toBeUndefined()
    expect(savedDefault.backoff).toBeUndefined()

    const customRun = openConfig(BENCH, { prog: 'rpt', backoff: true })
    pickSelectOption(customRun.host, 'Back-off drop', '15%')
    pickSelectOption(customRun.host, 'Back-off sets', 'Step down each set')
    pickSelectOption(customRun.host, 'Effort gate', 'Off')
    act(() => saveBtn(customRun.host).click())
    expect(customRun.onSave).toHaveBeenCalledTimes(1)
    const savedCustom = customRun.onSave.mock.calls[0][0]
    expect(savedCustom).toMatchObject({
      prog: 'rpt',
      backoffPct: 15,
      backoffMode: 'step',
      topMinRir: 0,
    })
    expect(savedCustom.backoff).toBeUndefined()
  })
})

describe('Live Workout RPT weight cascade (including pinned exercise units)', () => {
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
    S.workoutView = 'list'
    Object.assign(S, patch)
    S.active = {
      id: 'w-rpt-live', d: '2026-10-09', start: Date.now(), routineId: 'r1',
      name: 'Push', bw: null, cur: 0, entries, workoutView: 'list',
    }
    useStore.setState({ S, user: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push([root, host])
    act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
    return host
  }

  const weightInputs = host =>
    [...host.querySelectorAll('.wl-unit .stp input')].filter((_, i) => i % 2 === 0)

  it('recalculates back-off sets live in Workout when Set 1 or Set 2 is edited (step mode)', () => {
    const S = clone(DEF)
    S.unit = 'kg'
    const entry = {
      id: BENCH.id,
      ...buildPlannedEntry(
        S,
        { id: BENCH.id, sets: 4, reps: 10, repsMin: 7, weight: 80, prog: 'rpt', backoffPct: 10, backoffMode: 'step' },
        { id: 'r1', name: 'Push' }
      ),
    }
    const host = mountWorkout([entry])
    expect(weightInputs(host).map(el => el.value)).toEqual(['80', '72.5', '65', '55'])

    // Edit Set 1 to 85 kg -> [85, 77.5, 67.5, 60]
    const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    act(() => {
      const inp0 = weightInputs(host)[0]
      setVal.call(inp0, '85')
      inp0.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(weightInputs(host).map(el => el.value)).toEqual(['85', '77.5', '67.5', '60'])

    // Override Set 2 to 70 kg -> relative step offset (10%, 20% off 70) -> [85, 70, 62.5, 55]
    act(() => {
      const inp1 = weightInputs(host)[1]
      setVal.call(inp1, '70')
      inp1.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(weightInputs(host).map(el => el.value)).toEqual(['85', '70', '62.5', '55'])
  })

  it('steps and cascades cleanly in lb when an RPT exercise is pinned to lb on a kg profile', () => {
    const S = clone(DEF)
    S.unit = 'kg'
    S.exUnit = withExUnit({}, BENCH.id, 'lb', 1)
    // 185 lb stored in kg
    const w185kg = Math.round(185 * 0.45359237 * 1e4) / 1e4
    const entry = {
      id: BENCH.id,
      ...buildPlannedEntry(
        S,
        { id: BENCH.id, sets: 3, reps: 10, repsMin: 7, weight: w185kg, prog: 'rpt', backoffPct: 10, backoffMode: 'flat' },
        { id: 'r1', name: 'Push' }
      ),
    }
    const host = mountWorkout([entry], { exUnit: S.exUnit })
    // 185 lb * 0.9 = 166.5 lb -> nearest 5 lb step is 165 lb
    expect(weightInputs(host).map(el => el.value)).toEqual(['185', '165', '165'])

    // Click + on Set 1 -> 190 lb; 190 * 0.9 = 171 -> nearest 5 lb step is 170 lb
    act(() => {
      host.querySelector('.wl-unit .stp [aria-label*=": Increase"]').click()
    })
    expect(weightInputs(host).map(el => el.value)).toEqual(['190', '170', '170'])
    const liveS = useStore.getState().S
    expect(liveS.active.entries[0].sets.filter(s => !isWarmupRow(s)).map(s => shownWeight(liveS, BENCH.id, s.w))).toEqual([190, 170, 170])
  })
})

