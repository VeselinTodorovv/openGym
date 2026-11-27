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

describe('ExConfig & ProgressionFields for reactive Top set & back-offs (`rpt`)', () => {
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

    const { host: assistedHost } = openConfig(ASSISTED_DIP, { weight: 35 })
    act(() => findRow(assistedHost, 'Rule').click())
    const assistedPicker = mountSheet(useUI.getState().sheets.at(-1))
    expect(findRow(assistedPicker, 'Top set & back-offs')).toBeUndefined()
  })

  it('replaces static % toggles with Set effort presets, hides legacy Back-off sets switch, and previews live opening weight', () => {
    const { host } = openConfig(BENCH, { prog: 'rpt', sets: 3, weight: 80 })
    const stepRow = [...host.querySelectorAll('.cfgrow')].find(r =>
      r.querySelector('.stp-l')?.textContent.startsWith('Step')
    )
    expect(stepRow.querySelectorAll('.stp-w')).toHaveLength(4)
    expect(stepRow.classList.contains('cfgrow-4')).toBe(true)

    expect(host.querySelector('[role="switch"][aria-label="Back-off sets"]')).toBeNull()
    expect(findRow(host, 'Back-off drop')).toBeUndefined()
    expect(findRow(host, 'Set effort')?.querySelector('.lrow-v')?.textContent).toBe('RPE 8 → 9 → 10')
    expect(findRow(host, 'Effort gate')?.querySelector('.lrow-v')?.textContent).toBe('RPE 9 or easier')
    expect(host.textContent).toContain('Sets open at 80 kg and adjust live from your reps and effort. Set 1 drives progression.')
  })

  it('adapts Set effort and Effort gate labels to RPE vs RIR and shows a note when effort tracking is off', () => {
    act(() => useStore.setState(s => ({ S: { ...s.S, effort: 'rir' } })))
    const { host: rirHost } = openConfig(BENCH, { prog: 'rpt', rptRamp: '9-9-10', topMinRir: 2 })
    expect(findRow(rirHost, 'Set effort')?.querySelector('.lrow-v')?.textContent).toBe('1 → 1 → 0 RIR')
    expect(findRow(rirHost, 'Effort gate')?.querySelector('.lrow-v')?.textContent).toBe('2+ RIR in reserve')

    act(() => useStore.setState(s => ({ S: { ...s.S, effort: 'none' } })))
    const { host: offHost } = openConfig(BENCH, { prog: 'rpt' })
    expect(offHost.textContent).toContain(
      'Turn RPE or RIR on in Settings so sets adjust from your effort as well as your reps.'
    )
  })

  it('omits default RPT settings on Save and persists non-default rptRamp and topMinRir', () => {
    const defRun = openConfig(BENCH, { prog: 'rpt', rptRamp: '8-9-10', topMinRir: 1 })
    const saveBtn = h => [...h.querySelectorAll('button')].find(b => b.textContent === 'Save')
    act(() => saveBtn(defRun.host).click())
    const savedDefault = defRun.onSave.mock.calls[0][0]
    expect(savedDefault.prog).toBe('rpt')
    expect(savedDefault.rptRamp).toBeUndefined()
    expect(savedDefault.topMinRir).toBeUndefined()
    expect(savedDefault.backoffPct).toBeUndefined()
    expect(savedDefault.backoffMode).toBeUndefined()

    const customRun = openConfig(BENCH, { prog: 'rpt', backoff: true })
    pickSelectOption(customRun.host, 'Set effort', 'RPE 9 → 9 → 10')
    pickSelectOption(customRun.host, 'Effort gate', 'Off')
    act(() => saveBtn(customRun.host).click())
    expect(customRun.onSave.mock.calls[0][0]).toMatchObject({
      prog: 'rpt',
      rptRamp: '9-9-10',
      topMinRir: 0,
    })
  })
})

describe('Live Workout reactive RPT set adjustments (RPE ramp + pinned units)', () => {
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

  const weightInputs = host =>
    [...host.querySelectorAll('.wl-unit .stp.w input')]
  const repInputs = host =>
    [...host.querySelectorAll('.wl-unit .stp.r input')]
  const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set

  it('shows ~8 / ~9 / ~10 hints on open sets, keeps 60 kg after 60x8 @ RPE 8, and drops Set 3 to 55 kg after 60x6 @ RPE 9', () => {
    const S = clone(DEF)
    S.unit = 'kg'
    S.effort = 'rpe'
    const entry = {
      id: CABLE.id,
      ...buildPlannedEntry(
        S,
        { id: CABLE.id, sets: 3, reps: 10, repsMin: 6, weight: 60, inc: 5, prog: 'rpt', rptRamp: '8-9-10' },
        { id: 'r1', name: 'Pull' }
      ),
    }
    const host = mountWorkout([entry])
    expect(weightInputs(host).map(el => el.value)).toEqual(['60', '60', '60'])
    expect([...host.querySelectorAll('.effcell.is-empty')].map(el => el.textContent)).toEqual(['~8', '~9', '~10'])

    // Set 1: enter 8 reps, open RPE picker and select RPE 8 ("Two more reps") -> auto-ticks Set 1, Set 2 stays 60 kg
    act(() => {
      const r0 = repInputs(host)[0]
      setVal.call(r0, '8')
      r0.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[0].click())
    const effSheet1 = mountSheet(useUI.getState().sheets.at(-1))
    const rpe8Opt = [...effSheet1.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Two more reps'))
    expect(rpe8Opt).toBeTruthy()
    act(() => rpe8Opt.click())
    expect(weightInputs(host).map(el => el.value)).toEqual(['60', '60', '60'])

    // Set 2: enter 6 reps, pick RPE 9 ("One more rep in the tank") -> Set 3 drops automatically to 55 kg!
    act(() => {
      const r1 = repInputs(host)[1]
      setVal.call(r1, '6')
      r1.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[0].click())
    const effSheet2 = mountSheet(useUI.getState().sheets.at(-1))
    const rpe9Opt = [...effSheet2.querySelectorAll('.menu-item')].find(b => b.textContent.includes('One more rep in the tank'))
    expect(rpe9Opt).toBeTruthy()
    act(() => rpe9Opt.click())
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
        { id: BENCH.id, sets: 3, reps: 10, repsMin: 6, weight: w185kg, prog: 'rpt' },
        { id: 'r1', name: 'Push' }
      ),
    }
    const host = mountWorkout([entry], { exUnit: S.exUnit })
    expect(weightInputs(host).map(el => el.value)).toEqual(['185', '185', '185'])

    // Log Set 1 at 185 lb x 6 @ RPE 9.5 ("Maybe half a rep left") -> Set 2 & 3 snap onto a clean 5 lb step < 185 lb
    act(() => {
      const r0 = repInputs(host)[0]
      setVal.call(r0, '6')
      r0.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => host.querySelectorAll('.effcell.is-empty')[0].click())
    const effSheet = mountSheet(useUI.getState().sheets.at(-1))
    const rpe95Opt = [...effSheet.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Maybe half a rep left'))
    expect(rpe95Opt).toBeTruthy()
    act(() => rpe95Opt.click())

    const liveS = useStore.getState().S
    const lbWeights = liveS.active.entries[0].sets.filter(s => !isWarmupRow(s)).map(s => shownWeight(liveS, BENCH.id, s.w))
    expect(lbWeights[0]).toBe(185)
    expect(lbWeights[1]).toBeLessThan(185)
    expect(lbWeights[1] % 5).toBe(0)
    expect(lbWeights[2]).toBe(lbWeights[1])
  })
})
