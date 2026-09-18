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

- **Network editor** (React Flow): 16 components, loose port-to-port pipes, snap grid, minimap, 90° rotation (`R`),
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
  - *Signal wires* are a second, non-hydraulic edge type. Green = measurement (instrument `pv` → controller `cin`);
    wiring one turns a tank, pressure gauge, flow meter or ΔP gauge into a transmitter. Violet = command, 0–100 %
    (controller `sig` → device `ctl`, or into a logic gate / lamp).
  - A command *scales the device's own setting*: pump speed × command, throttle-valve opening × command; anything
    else is on/off. Throttle valves can have an actuator stroke time.
  - Blocks: manual switch, timer, limit switch with hysteresis (level / pressure / flow by what it's wired to), PID
    with auto/manual, anti-windup and bumpless transfer, AND/OR/NOT gate, alarm lamp.
  - Feedback blocks only act on the lab clock, never between ticks, so a pressure switch and its pump can't chase
    each other in zero time.
- **19 experiments** with briefs and auto-checked goals (gravity feed → Venturi/orifice meters → level switch,
  constant-pressure PID booster, flow loop with a motorised valve). `scripts/control-sim.ts` runs the loops closed
  in Node to prove each control goal is reachable and not trivially met.
- **Differential instruments**: a ΔP gauge tapped through zero-flow sensing lines (compiled as a closed link), and a
  Venturi/orifice element. EPANET only tracks piezometric head, so the throat differential is computed from Bernoulli
  in the educational layer and only the *permanent* loss is handed to the solver as a minor-loss K.
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
src/model/     types + defaults, units, physics (pure, SI)
src/engine/    inp.ts (compile) · epanet.ts (HydraulicEngine impl) · worker.ts + client.ts (threading)
               analysis.ts (curves, grade line)
src/experiments.ts   rig builder + the experiment catalogue
src/store.ts   zustand store, solve scheduling, tank time-stepping, persistence
src/ui/        nodes, animated pipe edge, inspector, charts, top bar, sidebar
```

`HydraulicEngine` is the seam for future solvers (water hammer / MOC, gas networks).
