# Third-party notices

FluidLab itself is released under the [MIT licence](LICENSE). The site it builds into also contains the software
and fonts below, each under its own licence. Their full licence texts, copied from the installed packages, are in
[`public/licenses.txt`](public/licenses.txt), which is served with the site at `/licenses.txt`. Regenerate it with
`npm run licenses` whenever dependencies change.

| Component                                                                  | What it does here                         | Licence                 |
| -------------------------------------------------------------------------- | ----------------------------------------- | ----------------------- |
| [EPANET 2.2](https://github.com/OpenWaterAnalytics/EPANET) (OWA)           | the pressurised-pipe solver               | MIT                     |
| [epanet-js](https://github.com/epanet-js/epanet-js-toolkit)                | EPANET compiled to WebAssembly            | MIT                     |
| [React](https://github.com/facebook/react), react-dom, scheduler           | user interface                            | MIT                     |
| [React Flow](https://github.com/xyflow/xyflow) (`@xyflow/react`, `system`) | the bench: nodes, edges, pan and zoom     | MIT                     |
| [zustand](https://github.com/pmndrs/zustand), use-sync-external-store      | state                                     | MIT                     |
| [d3](https://github.com/d3) modules, classcat                              | used inside React Flow                    | ISC · BSD-3-Clause, MIT |
| [Space Grotesk](https://github.com/floriankarsten/space-grotesk)           | interface typeface (via Fontsource)       | SIL OFL 1.1             |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)               | numeric / monospace typeface (Fontsource) | SIL OFL 1.1             |

EPANET was written at the U.S. Environmental Protection Agency and placed in the public domain; version 2.2 is
maintained by Open Water Analytics under the MIT licence. FluidLab is not affiliated with or endorsed by the EPA,
Open Water Analytics, or any of the projects above.

Build-time tools (Vite, TypeScript, tsx, oxlint and their dependencies) are not part of the distributed site.

The gas, steam, open-channel, water-hammer and heat engines, the control blocks and all artwork are original to
FluidLab. The methods they implement are textbook ones and are named, with their sources of validation, in the
[README](README.md).
