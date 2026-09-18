# FluidLab

A virtual hydraulics bench that runs entirely in the browser. Drag reservoirs, tanks, pumps, valves,
gauges and meters onto the canvas, pull pipes between their ports, and the network is re-solved
instantly by **EPANET 2.2 compiled to WebAssembly** (`epanet-js`). No server, no CFD.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static bundle in dist/
npm run test:engine  # solves a smoke network + every experiment rig in Node
```

## What's in it

- **Network editor** (React Flow): 26 components plus the catalogue, loose port-to-port pipes, snap grid, minimap, 90° rotation (`R`),
  undo/redo (`⌘Z` / `⇧⌘Z`, 100 steps, slider drags and typing coalesce into one step).
- **Runs off the main thread**: EPANET lives in a Web Worker behind a latest-wins client (no backlog while dragging a
  slider); falls back to the main thread if workers are unavailable.
- **Phone / touch layout**: below 860 px the side panels become slide-over sheets, parts are added by tap, ports grow
  for fingers, and the rig re-frames above the open details sheet.
- **Solver adapter**: FluidLab model → `.inp` → EPANET (Darcy–Weisbach) → SI results. Pumps/valves/meters are
  canvas nodes that compile to EPANET links between two hidden junctions. Parts not connected to a
  reservoir/tank are greyed out instead of breaking the solve.
- **Educational layer**: Re, friction factor, regime, valve K(opening), pump efficiency/power, NPSHa and
  cavitation, vapour-pressure and velocity warnings.
- **Live lab clock**: quasi-steady time stepping — solve, integrate tank volumes, solve again — so tanks
  fill and drain while you turn valves (1× – 1200×).
- **Charts**: pump curve × system curve with live operating point (system curve traced by sweeping pump
  speed), pipe ΔP(Q), hydraulic grade line, per-element trends.
- **Control layer** (`src/model/control.ts`): a PLC-style scan runs once per tick — read measurements, update every
  block, resolve commands, move actuators — and the commands are applied when the network is compiled.
  - _Signal wires_ are a second, non-hydraulic edge type. Green = measurement (instrument `pv` → controller `cin`);
    wiring one turns a tank, pressure gauge, flow meter or ΔP gauge into a transmitter. Violet = command, 0–100 %
    (controller `sig` → device `ctl`, or into a logic gate / lamp).
  - A command _scales the device's own setting_: pump speed × command, throttle-valve opening × command; anything
    else is on/off. Throttle valves can have an actuator stroke time.
  - Blocks: manual switch, timer, limit switch with hysteresis (level / pressure / flow by what it's wired to), PID
    with auto/manual, anti-windup and bumpless transfer, AND/OR/NOT gate, alarm lamp.
  - Feedback blocks only act on the lab clock, never between ticks, so a pressure switch and its pump can't chase
    each other in zero time.
- **Data-driven component library** (`src/model/catalog.ts`): ~20 fittings and pieces of equipment share one
  `fitting` component. A catalogue entry picks a loss model — `k` (minor-loss K; reducers/expanders derive it from
  their two bores) or `rated` (datasheet Δp @ Q with exponent n and a fouling slider, sent to EPANET as a GPV
  head-loss curve) — plus a P&ID glyph and defaults. Adding a part is a catalogue line, not a new component type.
  Also from the catalogue: valve bodies (gate, globe, ball, butterfly…) with equal-%/linear/quick-opening trims and
  a Kv/Cv readout, and nominal pipe sizes (steel Sch 40, copper L, PVC Sch 40, PEX) that set bore, material and
  roughness together.
- **Storage & sources**: the app integrates storage itself as _volume_, so tanks can be cylinders, cones, spheres or
  horizontal drums, and a **pressure vessel** (gas cushion, polytropic) is a fixed-head node whose head follows the
  gas law each tick. **Float valve**: a self-acting valve type that finds the tank on its outlet side and closes as
  it fills. **Demand patterns**: 24 h residential / commercial / industrial multipliers on the lab clock (re-solved
  per lab-minute). **Leaky joint**: a junction with an emitter, reporting loss per day.
- **Water-hammer engine** (`src/engine/transient.ts`): a second solver — the Method of Characteristics — started from
  the EPANET steady state and run in the same worker. Pipes are cut into reaches of one time step (wave speeds per
  material, nudged so every pipe holds a whole number of reaches; friction per reach taken from the steady solution,
  so an undisturbed network stays exactly steady). Boundary conditions: reservoirs/tanks, junctions with demand,
  emitters (nozzles, sprinklers, leaks), air vessels (gas law), relief valves, stroking valves, pumps coasting down
  behind a check valve, and every catalogue part as a quadratic loss. Vapour pressure is a floor, flagged as column
  separation. Operate a valve, pump or outlet from its inspector: peak/trough, Joukowsky's ρ·a·Δv, the critical time
  2L/a, pressure and flow histories anywhere, and a **replay on the bench** that drives gauges, pipe colours and
  flow particles with the recorded wave. `scripts/transient-check.ts` checks it against theory.
- **Domain kits** — still data, not new component types. _Discharge devices_ preset the outlet: K-factor
  sprinklers (sealed until their bulb breaks), hose reel, hydrant, drip emitters (plain and pressure-compensating),
  spray heads and rotors; Q = K·√p is exactly the solver's emitter. _Pump types_ set the curve shape as shut-off and
  run-out ratios — EPANET fits H = H₀ − B·Qᶜ through three points and `pumpHead()` uses the same form — giving a
  fire pump (with the NFPA 20 churn / 150 % checks in the inspector), a steep multistage and a flat circulator.
  Hydronics adds boiler, radiator and a balancing-valve body; closed loops solve with the expansion vessel as the
  pressure reference.
- **Round-out of the catalogue**: tapered reducers/diffusers, hose, a lossy three-port **tee** and a **three-way
  valve** (both compile to a hidden junction per port joined by lossy stubs), **air valve** (breaks a vacuum in the
  water-hammer engine), spring checks / foot valve / backflow preventers (check + pressure-breaker valve for the
  cracking pressure), PICV, solenoid and pinch presets, valve sizing by Kv/Cv. Pumps by **table** (catalogue points,
  or a **positive-displacement** pump with slip and an internal relief), efficiency chart, motor efficiency, tariff,
  kWh and cost; borehole, jockey and dosing presets; turbine / pump-as-turbine with recovered power. Flow-meter
  sensing principles with their own losses, pitot and sight glass, U-tube manometer display, totalisers, CSV export
  of everything recorded. Control: **pump sequencer** (staging with hysteresis, shared trimmed speed, lead rotation),
  **setpoint scheduler**, PID remote setpoint, S/R latch, emergency stop.
- **Gas network engine** (`src/engine/gas.ts`): picked automatically when the working fluid is a gas (air, natural
  gas, nitrogen, hydrogen, CO₂). Steady isothermal compressible flow — pipes obey p₁² − p₂² = (f·L/D + K)·ṁ²·Z·R·T/A²
  — solved as mass balances on absolute node pressures by damped Newton (central-difference Jacobian, a starting
  guess propagated from the sources through regulators and compressors, friction factors refreshed in an outer
  loop). The same bench is re-read: reservoirs are pressure sources, pumps are compressors (pressure-ratio map,
  isentropic power), PRVs are regulators with droop, pressure vessels are receivers that charge and blow down on the
  lab clock, nozzles and leaks choke at the critical ratio. Flows are standard volumes (15 °C, 1 atm). Controls,
  charts and goals work unchanged. `scripts/gas-check.ts` checks it against hand calculations. Elevation is ignored;
  tees, three-way valves and jet pumps are plain junctions; no water hammer or thermal layer for gases.
- **Steam** (`src/engine/steam.ts`, properties in `src/model/steam.ts`): pick "Saturated steam" as the fluid. The gas
  engine does the hydraulics with three changes — p/ρ comes from the steam table at each link's mean pressure instead
  of one Z·R·T, **steam loads** take duty ÷ h_fg(p) (so their demand depends on the pressure they get), and every pipe
  condenses what its surface loses (lagging thickness per pipe; conduction through mineral wool, then convection +
  radiation). Flows are mass flows: the flow unit switches to kg/h (t/h, lb/h) with the fluid. The steam layer then
  follows the **condensate**: each pipe's share travels downstream to the first working **steam trap** (or drip leg
  next to the main); what reaches a load instead is reported as carry-over, what reaches nothing is flagged as a
  water-hammer risk. Traps have an orifice capacity (derated for flashing) and a condition: a failed-open trap is a
  choked orifice blowing live steam, priced per plant year; a blocked one drains nothing. Reservoirs are boilers
  (feedwater temperature, efficiency, steam cost); throttling valves report the superheat they leave; loads warn when
  saturation temperature is below the process temperature + 5 K; loads and traps report flash steam at their return
  pressure. The thermal overlay shows steam temperature; the overview gives the heat balance. Saturated steam only:
  no superheated mains, no condensate-return pipework, no warm-up loads, no control valve / stall on the loads.
  `scripts/steam-check.ts` checks tables, mass balance, Darcy drop, choked trap and PRV against hand calculations.
- **Open-channel engine** (`src/engine/channel.ts`, hydraulics in `src/model/openchannel.ts`): any conduit can be
  switched from "pipe, flowing full" to "open channel" (rectangular, trapezoidal, V or part-full circular; Manning n from
  a lining catalogue), and anything connected to a channel part is a reach from the start. Bed levels come from the node
  elevations. Steady gradually-varied flow: reaches are oriented towards the nearest outfall and get their discharge from
  continuity; a subcritical standard-step pass runs upstream from every downstream control (free drop, fixed tailwater,
  normal depth, weir, gate, junction level), a supercritical pass runs downstream from every upstream control (critical
  inlet, gate vena contracta, weir toe), and at each station the profile with the larger specific force wins — the
  hand-over is the **hydraulic jump** (HEC-RAS's mixed-flow method). Forks are iterated until both branches agree on
  the level at the fork. Parts: **inflow**, **weirs** (sharp-crested/Rehbock, contracted/Francis, V-notch, Cipolletti,
  broad-crested, Parshall flume; Villemonte when drowned; a `pv` flow output), **sluice gate** (free and drowned/Henry;
  takes a controller's command), **outfall**. Readings give yₙ, y꜀, slope class, Froude range, the profile name
  (M1, S2, "M3 → jump → M1" …), jump depths and the power it dissipates; the inspector draws the water surface against
  bed, normal and critical depth along the main stem; warnings cover overtopping, scour and pipes running full.
  Channels and pipework share a bench but exchange no water: each is solved by its own engine and the results merged.
  Steady only (no flood routing), one bed level per node (no drops), more than two branches split equally.
  `scripts/channel-check.ts` checks it against hand calculations.
- **Jet pump (ejector)**: three ports, and both of its internal links depend on heads elsewhere in the network — the
  nozzle sees motive − suction, the entrainment curve scales with motive − discharge — which no single EPANET element
  can express. The engine wraps EPANET in a relaxed fixed-point: solve, read those heads, rebuild the nozzle's K and
  the entrainment pump curve from Cunningham's N(M, R) model, solve again (settles in a handful of passes, ~10 ms).
  Inspector shows M, N, R, efficiency M·N and the characteristic with the operating point. In the water-hammer
  engine it is a plain junction.
- **Thermal layer** (`src/engine/thermal.ts`): once flows are known, water temperature is carried round the loop —
  mixed at junctions, reset by a boiler, given up by emitters (NTU model against a constant room temperature).
  Shows as a "Thermal" pipe-colour overlay with temperatures and heat duty per part. Steady-state, no pipe heat loss.
- **Sources**: a reservoir is an open surface, a **mains connection** quoted in pressure, or a **well** whose pumping
  level is drawn down in proportion to yield (a head-loss curve between the aquifer and the pumping node). Tanks can
  **overflow** at the rim (spill reported) instead of shutting their inlet; the float valve has an **altitude-valve**
  mode (latched shut / open); household **fixtures** (taps, shower, WC, appliance) are K-factor presets; a **burst
  main** is a dormant 40 mm leak that can be ruptured as a water-hammer event.
- **Relief valve**: a PSV venting to an atmospheric reservoir through a stub pipe — holds its set pressure by
  lifting just far enough.
- **Searchable palette** with collapsible groups; catalogue parts travel as `kind:variant`.
- **46 experiments** with briefs and auto-checked goals (gravity feed → Venturi/orifice meters → level switch,
  constant-pressure PID booster, flow loop with a motorised valve → fittings, clogging strainer vs NPSH, relief
  valve → pressure vessel short-cycling, night flow & leakage, tank shapes, float valve → sprinkler branch line, fire-pump acceptance test, irrigation lateral uniformity,
  balancing a heating loop → water hammer, surge vessel, pump trip → standpipe, booster set with a sequencer, jet pump → compressed-air main, gas service regulator, choked blowdown → uniform flow, backwater behind a weir, sluice gate & hydraulic jump, spillway chute → sizing a steam main, lagging and drip traps, reducing station and a blowing trap). `scripts/control-sim.ts` runs the loops closed
  in Node to prove each control goal is reachable and not trivially met.
- **Differential instruments**: a ΔP gauge tapped through zero-flow sensing lines (compiled as a closed link), and a
  Venturi/orifice element. EPANET only tracks piezometric head, so the throat differential is computed from Bernoulli
  in the educational layer and only the _permanent_ loss is handed to the solver as a minor-loss K.
- **Units engine**: SI stored, anything displayed (kPa/bar/psi/m H₂O, L/min/GPM/m³/h, mm/in, W/hp …).
- **Fluids**: water at 20/60/90 °C, glycol mix, diesel, light oil.
- Autosave to localStorage, JSON project save/open.

## Deploy (Fly.io)

FluidLab is a static bundle, so the image is just a Node build stage + nginx (`Dockerfile`, `deploy/nginx.conf`).
Machines auto-stop when idle and wake on the first request.

```bash
fly launch --copy-config --no-deploy   # once: creates the app — choose a unique name and your region
fly deploy                             # build remotely and ship
```

## Layout

```
src/model/     types + defaults, units, physics, openchannel, steam (pure, SI)
src/engine/    inp.ts (compile) · epanet.ts (steady engine) · gas.ts (gas engine) · steam.ts (steam layer) · channel.ts (open-channel engine)
               transient.ts (water-hammer engine) · thermal.ts (heat layer)
               worker.ts + client.ts (threading)
               analysis.ts (curves, grade line)
src/experiments.ts   rig builder + the experiment catalogue
src/store.ts   zustand store, solve scheduling, tank time-stepping, persistence
src/ui/        nodes, animated pipe edge, inspector, charts, top bar, sidebar
```

`HydraulicEngine` is the seam solvers plug into: EPANET, the gas engine and the open-channel engine all sit behind it today, with steam as a layer on the gas engine; transient heat transfer is still to come.
