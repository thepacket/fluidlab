# Contributing

Thanks for looking. FluidLab is a teaching tool, so the bar for a change is: it is physically right, a student can
see what it does, and it does not break a rig that worked before.

## Getting started

```bash
npm install
npm run dev          # the app, with hot reload
npm run test:engine  # every solver check and all experiment rigs, in Node
npm run build        # type-check + production bundle
npm run lint
npx prettier --check src scripts "*.md"
```

Node 24, as in the `Dockerfile`. Everything runs locally; there is no backend.

## Reporting a wrong answer

The most useful issue is a rig that gives a wrong number. Use **Save** in the app and attach the project file (or
paste a **Share** link), and say what you expected and where that figure comes from — a hand calculation, a textbook
example, a standard. Units matter: say which ones you had selected.

## Changing the code

- **Physics lives in `src/model` and `src/engine`, in SI, with no UI imports.** Anything new there comes with a check
  in `scripts/` that compares it with a hand calculation or a published result, and `npm run test:engine` runs it.
  A solver change with no check will not be merged.
- **Layout is not hydraulics.** Positions, pipe routes, groups and other editor state must stay out of `props`, so
  that tidying a rig never re-solves it, and every change to the rig must go through `checkpoint()` so undo works.
- **The worker sees only what `slim()` in `src/engine/client.ts` sends it.** The scripts call the engines directly
  and cannot catch a field that is dropped on the way — check model changes in the browser too.
- **UI changes are checked in the browser**, at desktop and phone width. There are no UI tests yet.
- **Experiments** need a brief, steps, and a goal that the rig can reach but does not meet as loaded
  (`scripts/experiments.ts` checks both).
- Formatting is Prettier's (no semicolons, single quotes, 200 columns). Comments say why, not what.
- After adding or upgrading a dependency that ships in the bundle, run `npm run licenses` and commit
  `public/licenses.txt`.

Keep pull requests to one subject, and update the README where it describes what you changed.

## Licence of contributions

By contributing you agree that your contribution is released under the project's [MIT licence](LICENSE), and that
you have the right to release it. Do not paste in code, data tables or artwork from sources whose licence does not
allow that; cite the source of any engineering data you add.
