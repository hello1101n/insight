# FrontX problems for the v3 dashboards

For each FrontX problem that the prototype found, this list gives what Insight does now, what FrontX does, and why the FrontX way fails for Insight.

- Problems 1 to 4 block a real build.
- Problems 5 to 7 make the result worse than the current renderer.

The bump numbers refer to [frontx-dashboards-prototype.md](frontx-dashboards-prototype.md). The measurements come from synthetic mock dashboards on a local build. The prototype uses template commit `6bcd77f`. On 23 Nov 2026, the `main` branch of the public `itechmeat/gears-frontx-templates` fork had no change to these problems.

## 1. A dashboard cannot change after it loads

- **Insight now.** A dashboard is data from the Insight API. After an edit, React Query reads the dashboard again. React then draws the new version.
- **FrontX.** A `DashboardRoot` requests one served file from the host, one time. The file holds every dashboard and every widget type. The root caches the file and registers each dashboard in its type store. The type store keeps the first version of each ID and rejects a changed version with the same ID.
- **Why it fails.** Insight users make and edit dashboards at runtime. The root cannot accept a new version of a dashboard. The root also has no dispose function. The prototype makes a new root for each version, and each new root loads all widget code again, about 274 KB. The prototype cannot release the old roots.
- **Bumps.** 4 and 15.

## 2. Bars cannot stack by a column

- **Insight now.** A bar widget can name a series column, for example `outcome`. The chart groups the rows by that column and stacks the groups. Each team gets one bar with an "ok" part and a "failed" part.
- **FrontX.** The chart reads its data as named series. A CEL transform converts the Insight rows to that shape. The dashboard definition sets the stacking in `render.series`, a fixed list of series names.
- **Why it fails.**
  - CEL has no group function. The transform cannot make two series from eight rows. Each row becomes its own series, and the chart shows eight thin bars and eight legend entries.
  - The series names, such as "ok" and "failed", come only with the data. The dashboard definition must name them before the data arrives.
- **Bumps.** 2 and 3.

## 3. The packages cannot be installed from npm

- **Insight now.** Each dependency comes from npm. An update is a version change in `package.json`.
- **FrontX.** The dashboard packages are private packages in the template repository. They ship TypeScript source. They pin exact versions: React 19.2.4 and ui-kit 0.5.0.
- **Why it fails.**
  - The prototype copies the package into `vendor/`.
  - Insight uses React 19.3.1 and ui-kit 0.5.1. The pnpm overrides force the copied package onto these versions.
  - The TypeScript source fails the `erasableSyntaxOnly` compiler option and the Insight lint rules.
  - Each FrontX update needs a manual copy.
- **Bumps.** 5 to 9 and 21.

## 4. The larger view opens under the sidebar

- **Insight now.** The dialog of an expanded widget opens above the full page.
- **FrontX.** The root draws the larger view inside its own dashboard element. The larger view then keeps the dashboard theme.
- **Why it fails.** The Insight shell puts the content area in its own stacking context. The stacking context keeps the sticky top bar under the sidebar. No element in the content area can show above the sidebar.
- **Fix.** A new `overlayContainer` prop lets the host pass `document.body` as the container of the larger view. The pull request itechmeat/gears-frontx-templates#1 adds the prop. It has no review yet.
- **Bumps.** 20.

## 5. The page is slower and heavier

- **Insight now.** The widgets are part of the Insight bundle. They use the Insight copy of React and recharts.
- **FrontX.** Each widget type is a separate bundle that the page loads at runtime. The widget bundles share their own copy of React and recharts, and do not use the Insight copy. The root loads the bundles of all 15 widget types, also for a dashboard that uses two types. The widget code runs as `blob:` scripts.
- **Why it fails.**
  - The page holds two copies of React and two copies of recharts. The FrontX `recharts.js` has 1.38 MB before compression.
  - A dashboard with eight widgets draws in 1,670 ms. The current renderer needs 836 ms.
  - The JavaScript heap grows from 16 MB to 46 MB.
  - The page loads 31 more files, 716 KB after gzip.
  - The Insight content security policy must allow `blob:` scripts.
- **Bumps.** 16 and 17.

## 6. Tables are limited

- **Insight now.** A table accepts an answer of any size. It shows the first 200 rows and a note such as "First 200 of 1,234". Each column has its own format. A percent column shows `24.3%` next to plain counts.
- **FrontX.** The FrontX table widget, `grid`, accepts 500 rows or fewer. It has one `value_format` for all its columns.
- **Why it fails.**
  - An answer with more than 500 rows fails validation. The widget then shows an error in place of the table.
  - A grid cannot format a percent column apart from plain number columns. The prototype writes the percent as text, and the column sorts as text.
- **Bumps.** 24 and 25.

## 7. Two admin features are not available

- **Insight now.** When a widget lacks a column, the widget shows the admin the name of the missing column. An admin can open "Show data" to see the detail metric behind a widget.
- **FrontX.** A failed widget shows "This widget cannot be shown". The reason goes only to the browser console. The FrontX data view shows only the rows of the widget.
- **Why it fails.** Admins lose the reason for a failure and the drilldown into the detail metric.
