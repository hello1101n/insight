# FrontX problems for the v3 dashboards

For each FrontX problem that the prototype found, this list gives what Insight does now, what FrontX does, and why the FrontX way fails for Insight.

- Problems 1 to 3 block a real build.
- Problems 4 to 7 make the result worse than the current renderer.

The bump numbers refer to [frontx-dashboards-prototype.md](frontx-dashboards-prototype.md). The measurements come from synthetic mock dashboards on a local build. The prototype uses template commit `6bcd77f`. On 23 Nov 2026, the `main` branch of the public `itechmeat/gears-frontx-templates` fork had no change to these problems.

## 1. An edit shows only after a page reload

- **Insight now.** A dashboard is data from the Insight API. After an edit, React Query reads the dashboard again, and React draws the new version. The page does not reload.
- **FrontX.** A `DashboardRoot` asks the host for one served file, one time. The file holds the dashboard definitions: the widgets, their order, their titles and their chart settings. The root keeps the file for its full life. It has no public function to read the file again, and no dispose function.
- **Why it fails.** Insight users make and edit dashboards while the page is open. The root keeps the old definition until the page reloads, and only the widget data refreshes. To show an edit or a new dashboard without a reload, Insight must make a new root. Each new root loads all widget code again, about 274 KB. Insight cannot release the old roots.
- **Bumps.** 4 and 15.

## 2. Bars cannot stack by a column

- **Insight now.** A bar widget can name a series column, for example `outcome`. The chart groups the rows by that column and stacks the groups. Each team gets one bar with an "ok" part and a "failed" part.
- **FrontX.** The chart reads its data as named series. A CEL transform converts the Insight rows to that shape. The dashboard definition sets the stacking in `render.series`, a fixed list of series names.
- **Why it fails.**
  - CEL has no group function. The transform cannot make two series from eight rows. Each row becomes its own series, and the chart shows eight thin bars and eight legend entries.
  - The series names, such as "ok" and "failed", come only with the data. The dashboard definition must name them before the data arrives.
- **Bumps.** 2 and 3.

## 3. Overlays open inside the dashboard, not over the page

- **Insight now.** A dialog, such as the larger view of a widget, opens on the page body. It shows above the sidebar and the rest of the page.
- **FrontX.** FrontX draws its overlays inside its own elements. The root draws the larger view inside the dashboard element. Each widget draws its overlays inside its own container.
- **Why it fails.** The Insight shell puts the content area in its own stacking context. No overlay inside the content area can show above the sidebar. The larger view opens under the sidebar.
- **Fix.** The pull request itechmeat/gears-frontx-templates#1 adds an `overlayContainer` prop for the larger view. A new full-page overlay in FrontX needs the same fix.
- **Bumps.** 20.

## 4. The page is slower and heavier

- **Insight now.** The widgets are part of the Insight bundle. They use the Insight copy of React and recharts.
- **FrontX.** Each widget type is a separate bundle that the page loads at runtime. The widget bundles bring their own copy of React and recharts. The root loads the bundles of all widget types, even the types that a dashboard does not use.
- **Why it fails.** The page holds two copies of React and recharts. A dashboard takes about twice as long to draw and uses about three times the memory. The widget code runs as `blob:` scripts, so the Insight content security policy must allow them.
- **Bumps.** 16 and 17.

## 5. A table has one number format

- **Insight now.** Each column of a table has its own format. A percent column shows `24.3%` next to plain counts.
- **FrontX.** The FrontX table widget, `grid`, has one `value_format` for all its columns.
- **Why it fails.** A grid cannot format a percent column apart from plain number columns. The prototype writes the percent as text, and the column then sorts as text.
- **Bumps.** 25.

## 6. Long category names lose their labels

- **Insight now.** A chart shortens a long category name to 14 characters and adds "…". On a synthetic board with 12 long test names, 4 bars keep a short label.
- **FrontX.** The chart never shortens a label. It hides each label that overlaps the next one. Tilted labels and horizontal bars are available, but neither shortens a name.
- **Why it fails.** Category names, such as test names or repository names, can be long. On the same board, FrontX labels 1 bar of 12, with the full name.
- **Bumps.** 26.

## 7. Charts have five colours

- **Insight now.** Charts use a palette of 12 colours.
- **FrontX.** The chart palette has 5 colours. The sixth series or slice takes the first colour again.
- **Why it fails.** A stacked bar or a pie with more than five parts shows two parts in the same colour. On a synthetic pie with 7 slices, two pairs of slices share a colour.
- **Bumps.** 27.
