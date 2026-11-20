# FrontX dashboards prototype

This prototype is throwaway code. It examines one decision: should Insight move the `/dashboards/<id>` pages of the custom v3 dashboards to the FrontX dashboard template? All data in this document comes from the mock service worker. No number or example comes from a deployed environment.

## Question and answer

The question: can the FrontX dashboard template show the saved Insight dashboards inside the Insight frontend, and how does it behave?

The answer: it partly works. The FrontX renderer shows all six Insight widget kinds, headings and texts from the existing run endpoint, with no console errors. Stacked bars and tables with more than 500 rows are wrong, and a dashboard takes about twice as long to draw. Percent values are right only with a new field in the widgets answer, which the prototype mocks. Do not start a real build until the FrontX team answers the blocker questions.

## How to run the prototype

You need Node 24.14 or later, pnpm, and a clone of `gears-frontx-templates` (upstream `constructorfabric/gears-frontx-templates`).

1. Check out commit `6bcd77f11ebe6a073c1ec0501d6e93b7737d58d7` in the clone.
2. Build the widget bundles in the clone:

   ```sh
   cd template-dashboard
   npm ci
   npm run build:widgets
   ```

3. Install the Insight frontend:

   ```sh
   cd src/frontend
   pnpm install
   ```

4. Start the dev server. Set `FRONTX_WIDGETS_DIR` to the `dist` folder that step 2 wrote:

   ```sh
   FRONTX_WIDGETS_DIR=<clone>/template-dashboard/src-app/mfe_packages/widgets/dist \
     VITE_ENABLE_MOCKS=true pnpm exec vite --port 5176 --strictPort
   ```

5. Open a mock dashboard. Add `?frontx=1` to see it through FrontX:
   - `http://localhost:5176/dashboards/delivery-pulse?frontx=1` shows the mock dashboard with eight widgets through FrontX.
   - `http://localhost:5176/dashboards/delivery-pulse` shows the same dashboard through the current renderer.
   - "Example dashboards" lists the other mock dashboards.

If `FRONTX_WIDGETS_DIR` is not set, the dev server writes a warning. The `?frontx=1` page then shows a message that names the variable.

The scripts in `scripts/frontx-prototype/` repeat the measurements. Each script takes the server origin and an output folder as arguments. For example, `node scripts/frontx-prototype/observe.mjs http://localhost:5176 /tmp/frontx 5`.

### Prototype-only changes

Do not merge these changes. They exist only to compare the two renderers.

- The `?frontx=1` search parameter selects the FrontX renderer in `_shell.dashboards.$name.tsx`.
- `vendor/frontx-dashboard-root` is a copy of the template's dashboard root package. It is a pnpm workspace member.
- `package.json` has pnpm overrides that force `@gears-frontx/ui-kit` 0.5.1 into the copied package. The existing React override also applies to it.
- `tsconfig.app.json` sets `erasableSyntaxOnly` to `false`.
- `eslint.config.js` ignores `vendor`.
- `vite.frontx-widgets.ts` serves the widget bundles under `/widgets/`. `vite.config.ts` adds it and dedupes React.
- The dev mocks hold seven example dashboards in `src/mocks/example-dashboards.ts`. "Example dashboards" lists them.
- `DashboardWidget` in `src/api/custom-types.ts` has an optional `percents` field. Only the dev mocks send it. See bump 13.

## What works

- The adapter in `src/lib/custom/frontx-board.ts` makes a FrontX dashboard file from the Insight dashboard and its widgets. It has about 250 lines.
- The host in `src/components/custom/frontx-board.tsx` sends each data request through `fetchWithAuth` to the existing run endpoint. The FrontX code makes no network request for data on its own.
- Each Insight widget kind has a FrontX widget type:
  - `table` uses `grid`.
  - `line`, `area` and `bar` use `cartesian_chart`.
  - `stat` uses `metric_card`.
  - `pie` uses `pie_chart`.
  - A heading or a text uses a frameless `markdown_card`.
- A CEL transform in the dashboard file converts each run result into the data of its widget.
- The time range is a FrontX variable. A range change sends the run request again for the seven widgets that have a clock. The all-time pie chart keeps its data.
- The theme comes from the `data-theme` attribute of the Insight page. A theme switch restyles every widget and sends no request.
- The larger view opens and sends one run request. The data view of a chart sends no request.
- A widget with no clock shows "All time" under its title.
- A date bucket on the x axis shows formatted dates.
- The widgets keep the two columns of the current renderer. The adapter turns off the flexible FrontX layout.
- A percent column shows as a percent when the widgets answer names it. A stat, a chart or a pie gets the FrontX percent format, and the transform divides the value by 100. A table writes the column as text, such as `24.3%`. Both renderers show the mock change failure rate as `12.8%`.

## Bumps log

The entries are in the order the prototype hit them.

1. **Insight has no route for widget bundles.**
   - What happened: the FrontX dashboard loads each widget bundle at runtime from `/widgets/`.
   - Workaround: a Vite middleware serves the folder that `FRONTX_WIDGETS_DIR` names.
   - Real build: an Insight change. nginx must serve `/widgets/`. Hashed files under `assets/` can stay in the cache. The lists, the parts and `shared/` must revalidate.
2. **CEL cannot find a column by name.**
   - What happened: the run endpoint answers `{columns, rows}` with positional rows. The CEL library has no list `indexOf`, so a transform cannot find the position of a column.
   - Workaround: the host adds `at`, a map from each column name to its position.
   - Real build: a FrontX change (CEL list functions) or an Insight change (an answer with keyed rows).
3. **CEL cannot group rows.**
   - What happened: a bar widget with a `series` column needs one series for each value of that column. CEL has no group or distinct function. The `render.series` list must also name each series before the data arrives.
   - Workaround: none. Each row becomes its own series. The chart shows eight thin bars and eight legend entries in place of two stacked series.
   - Real build: a FrontX change.
4. **The root reads the dashboard file only once.**
   - What happened: a `DashboardRoot` loads its served file once and keeps it. Insight users make and edit dashboards at runtime.
   - Workaround: one root for each dashboard file. A changed dashboard gets a new root.
   - Real build: a FrontX change. The root must load or replace one dashboard at runtime, and a root must have a dispose function.
5. **The dashboard packages are not published.**
   - What happened: the two template packages are private. npm does not have them.
   - Workaround: the prototype copies the dashboard root package into `vendor/`.
   - Real build: a FrontX change (publish the packages), or an Insight process to update a vendored copy.
6. **The packages pin exact versions.**
   - What happened: the root package pins React 19.2.4 and ui-kit 0.5.0. Insight uses React 19.3.1 and ui-kit 0.5.1.
   - Workaround: pnpm overrides.
   - Real build: a FrontX change (peer ranges).
7. **Two exports have the same name.**
   - What happened: the package index exports the `Dashboard` component, which hides the `Dashboard` contract type.
   - Workaround: the prototype imports the types from `@gears-frontx/frontx-dashboard-root/contract`.
   - Real build: a FrontX change (rename one of them).
8. **The TypeScript source fails an Insight compiler option.**
   - What happened: the package ships TypeScript source. `tsc -b` reported seven errors: `erasableSyntaxOnly` rejects the constructor parameter properties in `binding.ts` and `registry.ts`.
   - Workaround: the prototype sets `erasableSyntaxOnly` to `false`.
   - Real build: a FrontX change (ship JavaScript and declaration files, or use only erasable syntax).
9. **The served file type is too narrow.**
   - What happened: `ServedFile.instances` is `Record<string, unknown>[]`. The contract `Dashboard` interface does not match that type.
   - Workaround: the adapter puts a spread copy of the dashboard in the list.
   - Real build: a FrontX change (minor).
10. **The router read the switch as a number.**
    - What happened: TanStack Router parses `?frontx=1` as the number 1. The search check accepted only a string, so the page stayed on the current renderer.
    - Workaround: the search check accepts the number.
    - Real build: nothing. The switch is prototype-only.
11. **CEL types both branches of a conditional.**
    - What happened: every cell failed with "Ternary branches must have the same type". A nullable number has a `null` branch and a `double` branch.
    - Workaround: both branches go through `dyn()`.
    - Real build: nothing. A FrontX note on this pattern would help authors.
12. **The x axis showed raw dates.**
    - What happened: a category axis shows `2026-10-03` where the current renderer shows `Oct 3`.
    - Workaround: the adapter sets `x_axis.type` to `time` when the x column is `bucket`.
    - Real build: nothing. Other date columns need the same rule.
13. **The percent columns arrive only with the run answer.**
    - What happened: an Insight percent column holds 0 to 100. The current renderer adds `%` to each column in the `percents` list of the run answer. A FrontX percent format reads a fraction (0.25 shows as 25%), and the dashboard file sets it before any answer arrives. The metric definition marks each percent field, but only an administrator can read a metric definition. The dashboard read and the widgets answer do not carry the flag. So nothing that a dashboard viewer reads before the run names the percent columns.
    - Workaround: the dev mocks add `percents` to each item of the widgets answer. With it, the adapter sets the percent format and divides by 100 in the transform.
    - Real build: an Insight change. `GET /v1/dashboards/{id}/widgets` must return the percent columns of the drawn metric beside `clock`. The service already reads that metric to find the clock. Without the field, a percent shows as a plain number, such as `12.8` for 12.8%.
14. **Stylesheets loaded again after each redraw.**
    - What happened: each widget adds its stylesheets as `<link>` elements in its shadow root. With `cache-control: no-cache`, the browser asked for them again after a range change.
    - Workaround: the middleware marks the hashed files under `assets/` as immutable.
    - Real build: an Insight change in the nginx cache rules.
15. **A new root loads every part again.**
    - What happened: the page switched to another dashboard. The new root fetched all 16 parts and its widget code again (274 KB). The two roots share no load.
    - Workaround: none.
    - Real build: a FrontX change (see entry 4).
16. **Every root loads the parts of all widget types.**
    - What happened: the widget list names 15 widget types. Each dashboard load fetched all 15 parts, even when the dashboard used two types.
    - Workaround: none. Insight can publish a shorter widget list.
    - Real build: a FrontX change (one joined file, or parts that load on demand).
17. **The widget bundles bring their own React and recharts.**
    - What happened: the widgets share React 19.2.4 and recharts among themselves, but not with the host. The page holds two copies of each. The shared `recharts.js` is not minified and has 1.38 MB before compression.
    - Workaround: none.
    - Real build: a FrontX change.
18. **The timing run needed mocks in a production build.**
    - What happened: Insight starts the mock service worker only in dev mode.
    - Workaround: a temporary local change in `main.tsx`. The branch does not keep it.
    - Real build: nothing.
19. **The preview server answered asset requests with 404.**
    - What happened: `vite preview` answered 71 requests for each page load under `/dashboards/assets/` with 404. Both renderers had them.
    - Workaround: none. They come from the relative asset base of the Insight build, not from FrontX. The prototype did not examine them further.
    - Real build: nothing for FrontX.
20. **The larger view opens under the sidebar.**
    - What happened: the larger view dialog stays inside the dashboard element. The Insight `main` element has `isolation: isolate`, so the sidebar paints over the left part of the dialog. The dialog title is not visible.
    - Workaround: the copied package has a new `overlayContainer` prop on `Dashboard`. The host passes `document.body`, so the dialog opens above the sidebar in the light and dark themes. Insight cannot remove `isolation: isolate`: it keeps the sticky top bar under the fixed sidebar.
    - Real build: a FrontX change (the same prop, or an overlay that mounts in the page body).
21. **The copied package fails the Insight lint rules.**
    - What happened: `eslint .` reported 18 errors and 3 warnings in `vendor/frontx-dashboard-root`, for example `no-control-regex`.
    - Workaround: `eslint.config.js` ignores `vendor`.
    - Real build: a FrontX change (ship built JavaScript), or an Insight rule that excludes vendored code.
22. **Insight widgets have no multi-series line and no grouped bar.**
    - What happened: the example dashboards could not show a line or an area with several series, or a grouped bar. An Insight `line` or `area` widget names one `y` column. A `bar` widget with a `series` column always stacks.
    - Workaround: the `breakdowns` dashboard says so in a text.
    - Real build: nothing. The FrontX `cartesian_chart` can draw these, so a later Insight widget change can use them.
23. **The flexible FrontX grid put three widgets in a row.**
    - What happened: the FrontX grid shrinks medium cells to fill a row, so a row of the `trends` dashboard held three widgets. The current renderer always draws two columns.
    - Workaround: the adapter sets `layout.flexible` to `false`.
    - Real build: nothing.
24. **A grid with more than 500 rows fails its cell.**
    - What happened: the table with 650 rows shows "This widget cannot be shown". The console names the cause: "Too many items in `#/rows`, should be `500` at most". The current renderer shows the first 200 of 650 rows.
    - Workaround: none. The host can cut the rows before the transform, but that is data code in the host.
    - Real build: a FrontX change (grid paging from the request, or a higher limit), or an Insight change in the host.
25. **A grid has one value format.**
    - What happened: FrontX formats every number of a grid with one `value_format`, so a table cannot hold one percent column among plain numbers.
    - Workaround: the transform writes a percent column as text with one decimal, such as `24.3%`. The column then sorts as text.
    - Real build: a FrontX change (a format for each column).

## Blockers for the custom v3 dashboards

The list starts with the most important blocker.

| Rank | Blocker                                                                                                                                                         | Owner                                         | Effect                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| 1    | The root cannot load, replace or release one dashboard at runtime.                                                                                              | FrontX                                        | Blocks a real build                              |
| 2    | A transform cannot group rows, and `render.series` cannot style series that come from the data. Bar widgets with a `series` column draw wrong.                  | FrontX (or Insight, with grouped answers)     | Blocks a real build                              |
| 3    | The larger view opens under the Insight sidebar. A one-prop FrontX change fixes it (bump 20).                                                                   | FrontX (or Insight)                           | Blocks a real build                              |
| 4    | The packages are private, ship TypeScript source and pin exact versions.                                                                                        | FrontX                                        | Blocks a real build                              |
| 5    | Nothing that a viewer reads before the run names the percent columns. The widgets answer needs a `percents` field (bump 13).                                    | Insight                                       | Blocks a real build until Insight adds the field |
| 6    | A dashboard takes longer to draw, uses more memory and loads more code. See "Measurements".                                                                     | FrontX                                        | Quality gap                                      |
| 7    | The admin drilldown and the missing-column message are not available.                                                                                           | Insight and FrontX                            | Quality gap                                      |
| 8    | Deployment needs the `/widgets/` route, a CSP that allows `blob:` scripts, and a bundle base for the `/exp/<name>/` previews. The prototype did not test a CSP. | Insight (FrontX for a bundle base at runtime) | Blocks deployment until Insight does the work    |
| 9    | A grid with more than 500 rows fails its cell, and a grid has one value format for all its columns.                                                             | FrontX (or Insight, in the host)              | Quality gap                                      |
| 10   | Widget texts are English only, cells have fixed heights, and failed cells do not say why.                                                                       | FrontX                                        | Quality gap                                      |

## Gaps against the current dashboards

- Stacked bars by a `series` column draw as one series for each row. The legend then repeats each value and can run past the cell.
- Percent values need the `percents` field in the widgets answer. Without it, a percent shows as a plain number. A percent table column is text and sorts as text.
- A table with more than 500 rows fails its cell. The current renderer shows its first 200 rows.
- The admin "Show data" drilldown into a detail metric is not available. The FrontX data view shows only the rows of the widget.
- The admin message that names a missing column becomes "This widget cannot be shown" and a console line.
- The empty-window text "Nothing in this window. Try a wider range." becomes "No data to show". All widget texts are English.
- A failed run shows "This widget cannot be shown" and "Try again". The current renderer shows the reason from the service to an administrator, and "Busy, try again." for a busy service.
- A stat with no value shows "No data to show" and loses its label. The current renderer shows a dash and keeps the label. A stat with no label shows no caption, where the current renderer shows the column name.
- FrontX shows up to two decimals, such as `47.25`. The current renderer shows one decimal for a value of 10 or more, such as `47.3`.
- Date ticks include the year, such as `Oct 1, 2026`. A wide table scrolls sideways inside its cell.
- Cells have fixed heights. A table shows five rows and then pages. The grid data holds 500 rows at most.
- The "All time" badge becomes a line under the title. Headings lose the small uppercase style. Table headers are uppercase and the row-number column is gone. Axis titles show the column names.
- The `?widget=` link to an expanded widget has no FrontX equivalent.

## Example dashboards

The dev mocks hold these dashboards. Every number is synthetic. The paired screenshots of the pull request show each dashboard in both renderers.

- `delivery-pulse`: one widget of each kind, two headings, one text and three time ranges. The change failure rate is a percent stat.
- `delivery-overview`: one table and no time range.
- `kpi-overview`: eight stats. They show plain numbers, percents above and below 10, amounts in USD, a large number, a negative number and an empty value.
- `breakdowns`: a stacked bar with four severities over six teams, bars with labels, and a percent bar. It also has a pie with 14 slices, a percent pie with no clock, and a bar over 16 long service names.
- `trends`: daily lines and an area over a quarter, a percent line, a bar over days, and a line with gaps.
- `pipeline-runs`: a long dashboard title and no time range. It holds a table with 12 columns and 650 rows, a table with 9 rows and a percent column, and a line with no clock.
- `edge-cases`: a long heading, a long text, a long widget title and a long stat label. It also has a line and a table with no rows, a run that fails, a busy run, and a pie that names a column the metric does not return.
- `reading-notes`: headings and texts only.

The notable differences per dashboard:

- `kpi-overview`: the stat values agree. FrontX cells are taller, `47.25` shows where the current renderer shows `47.3`, and the empty stat loses its label.
- `breakdowns`: the stacked bar breaks in FrontX (bump 3). The current pie legend with 14 slices runs past the card edge. The FrontX pie legend shows 7 of 14 entries.
- `trends`: the charts agree. FrontX shows the year in each date tick.
- `pipeline-runs`: the 650-row table fails in FrontX (bump 24). The 9-row table shows three rows and pages, and its percent column is off to the right.
- `edge-cases`: every failure stays in its cell in both renderers. FrontX says "This widget cannot be shown" for the failed run, the busy run and the wrong column alike.
- `reading-notes`: both renderers show the text. FrontX headings are larger and not uppercase.

## Measurements

The measurements compare the two renderers on `delivery-pulse` and `delivery-overview`. They predate the other example dashboards. They come from a local mock build, so the absolute numbers are not production numbers. The differences between the renderers are the result.

How the prototype measured:

- A production build of the prototype ran under `vite preview` on localhost. A temporary local change started the mock service worker in that build.
- Headless Chromium from Playwright 1.62.1 opened each page at 1440 x 2400 pixels.
- Each renderer had one warm-up load. Then each renderer had five loads for each dashboard and each theme. The two renderers alternated.
- The machine has 12 cores. Other work ran on it, and the load average was about 14 during the runs.
- "Drawn" is the time from the navigation start to the first frame in which every cell shows drawn content. It includes about 750 ms of Insight start-up, which is the same for both renderers.
- The heap value is the used JS heap after a forced garbage collection.

The table shows the results for the light theme. The dark theme gave the same values within the ranges.

| Value                               | Current             | FrontX                     |
| ----------------------------------- | ------------------- | -------------------------- |
| Drawn, dashboard with eight widgets | 836 ms (816 to 843) | 1671 ms (1613 to 1727)     |
| Drawn, dashboard with one table     | 746 ms (735 to 803) | 1219 ms (1209 to 1226)     |
| Heap, dashboard with eight widgets  | 16.4 MB             | 45.6 MB                    |
| Heap, dashboard with one table      | 10.5 MB             | 19.7 MB                    |
| Data requests, eight widgets        | 8                   | 8                          |
| Widget part files, eight widgets    | 0                   | 16                         |
| Widget code files, eight widgets    | 0                   | 15                         |
| Widget files, eight widgets, size   | 0                   | 3.07 MB, 716 KB after gzip |
| Lazy FrontX chunk of the host       | none                | 878 KB, 250 KB after gzip  |

The drawn values are medians of five runs, with the range in parentheses.

The limiter comes from one profiled load of the dashboard with eight widgets. The FrontX steps run one after another:

1. The host loads the lazy FrontX chunk at 744 ms.
2. The root starts and registers its types. That takes about 300 ms.
3. The root fetches the widget list and the 15 parts.
4. The root registers the parts. That takes about 140 ms.
5. The data requests and the widget code start at about 1250 ms. The widget code ends at about 1600 ms, when the last cell draws.

The CPU profile shows 236 ms in the FrontX chunk. It also shows about 75 ms in the regular expressions that rewrite the imports of the widget code. The data requests are not on the critical path.

Interactions, one run each:

- Range change: both renderers sent 7 data requests and no widget file. The last redraw came 130 ms (current) and 242 ms (FrontX) after the click.
- Theme switch: both renderers sent no request.
- A switch to another dashboard in the same page fetched 16 parts and 274 KB of widget files. A switch back to a dashboard that the page showed before fetched no widget file. The heap went from 45.6 MB to 47.5 MB, 53.7 MB and 50.6 MB.
- No console error came from either renderer.

A dev-mode run of `observe.mjs` on this branch gives the same pattern. One run at a load average of about 6 gave these values for the dashboard with eight widgets: drawn 1350 ms against 2056 ms, heap 59.6 MB against 90.6 MB.

## Result of ui-kit 0.5.1

The upgrade from ui-kit 0.4.10 to 0.5.1 breaks nothing in Insight:

- `tsc -b --force` reported no errors.
- The full `vitest run`, with the unit and Storybook projects, passed 4740 of 4741 tests. The one failed Storybook test of `metric-timeseries-view` passed when it ran alone.
- Screenshots of the home page, the dashboard list and the two mock dashboards, in the light and dark themes, show 0.00% changed pixels. `pixdiff.mjs` reports 0.62% to 0.81% for two screenshot sets that do differ, so the tool can find a change.

## Questions for the FrontX team

1. Can a host load or replace one dashboard at runtime, for example after an edit? Can a host release a `DashboardRoot`?
2. Can CEL get list functions, such as `indexOf`, a group function or two-variable comprehensions?
3. Can a cartesian chart stack series that come from the data, for example with a default `stack_group`?
4. Can a value format come from the data? Can a percent format read values from 0 to 100? Can a grid format each column on its own?
5. Can the larger view render into a portal that the host gives, such as `document.body`?
6. Can the widgets use the React, recharts and ui-kit of the host? Why is the shared `recharts.js` not minified?
7. Can a dashboard load only the parts of the widget types it uses, or one joined file? Can the data requests start before the root registers the parts?
8. Will the packages ship JavaScript and declaration files, and use peer ranges in place of exact pins?
9. Can the host set the bundle base at runtime, for the `/exp/<name>/` previews?
10. Can grid data hold more than 500 rows? When can a host translate the widget texts (gears-frontx-templates#105)?

## Recommendation

Do not start a real build of the FrontX dashboards now. The adapter is small, but the move makes the page slower and heavier, and it loses features. Ask the FrontX team questions 1, 2, 3, 5 and 6 first. Start a real build when FrontX resolves blockers 1 to 4 and Insight adds the `percents` field of blocker 5.

Ship the ui-kit 0.5.1 upgrade on its own. It needs no other change.
