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

- **Network editor** (React Flow): 8 components, loose port-to-port pipes, snap grid, minimap, delete key.
- **Solver adapter**: FluidLab model → `.inp` → EPANET (Darcy–Weisbach) → SI results. Pumps/valves/meters are
  canvas nodes that compile to EPANET links between two hidden junctions. Parts not connected to a
  reservoir/tank are greyed out instead of breaking the solve.
- **Educational layer**: Re, friction factor, regime, valve K(opening), pump efficiency/power, NPSHa and
  cavitation, vapour-pressure and velocity warnings.
- **Live lab clock**: quasi-steady time stepping — solve, integrate tank volumes, solve again — so tanks
  fill and drain while you turn valves (1× – 1200×).
- **Charts**: pump curve × system curve with live operating point (system curve traced by sweeping pump
  speed), pipe ΔP(Q), hydraulic grade line, per-element trends.
- **12 experiments** with briefs and auto-checked goals (gravity feed → PRV regulation).
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
src/engine/    inp.ts (compile) · epanet.ts (HydraulicEngine impl) · analysis.ts (curves, grade line)
src/experiments.ts   rig builder + the experiment catalogue
src/store.ts   zustand store, solve scheduling, tank time-stepping, persistence
src/ui/        nodes, animated pipe edge, inspector, charts, top bar, sidebar
```

`HydraulicEngine` is the seam for future solvers (water hammer / MOC, gas networks).
