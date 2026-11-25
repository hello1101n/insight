"""Render the seeder's committed `PROFILE.md` from a manifest document.

PROFILE.md is the human-readable companion to `manifest.json`: it tells a
person (or an agent planning a test) what a seeded stand actually contains —
who the personas are, which fixtures exist, what the data window is, and
which metrics carry known expected values.

It is GENERATED. `render_profile` is a pure function of the manifest, so the
page can never drift from the machine-readable document it describes, and a
staleness check is a byte comparison.

This module does not import `os`: it is structurally incapable of picking up
ambient state, which is what keeps the committed page a function of committed
bytes rather than of whoever last ran the generator.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from . import manifest

REGEN_COMMAND = "python3 -m insight_seed.render_profile"
CHECK_COMMAND = "python3 -m insight_seed.render_profile --check"


def profile_path() -> Path:
    """The committed profile page, in the working directory.

    Not derived from this module's location: an installed package lives wherever
    pip put it, and this page belongs to the checkout. `render_profile` is a
    developer tool run from the seeder's directory (see the README).
    """
    return Path.cwd() / "PROFILE.md"


def _table(headers: list[str], rows: list[list[str]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return out


def _cell(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, list):
        return ", ".join(str(v) for v in value) if value else "—"
    return str(value)


def render_profile(doc: manifest.Manifest) -> str:
    """Render the page. Pure function of `doc`; no clock, no env, no I/O."""
    lines: list[str] = [
        "<!-- GENERATED FILE — do not hand-edit.",
        f"     Regenerate: {REGEN_COMMAND}",
        f"     Verify:     {CHECK_COMMAND}",
        "     Content is derived from insight_seed/manifest.py + profiles.py. -->",
        "",
        "# Seed Profile",
        "",
        "What a stand seeded by the seeder contains. Generated from the same",
        "builder that writes `manifest.json`, so the two cannot disagree.",
        "",
        "## Stand summary",
        "",
    ]

    lines += _table(
        ["Field", "Value"],
        [
            ["tenant", f"`{_cell(doc['tenant'])}`"],
            ["tenant (other)", f"`{_cell((doc.get('tenants') or {}).get('other'))}`"],
            ["realm", f"`{_cell(doc['realm']['name'])}`"],
            ["anchor_date", f"`{_cell(doc['anchor_date'])}`"],
            ["data_window", f"`{_cell(doc['data_window'])}`"],
            ["seed_revision", f"`{_cell(doc['seed_revision'])}`"],
            ["manifest_version", _cell(doc["manifest_version"])],
        ],
    )
    lines += [
        "",
        "`anchor_date` is the last day carrying seeded activity. It is resolved",
        "once per run from `SEED_ANCHOR_DATE` (an ISO date, or the literal",
        "`today`) and defaults to yesterday UTC — the current day is excluded so",
        "a partial day does not fight the gold views' day-aligned aggregates.",
        "Pin it to reproduce a dataset exactly; the value above is the one this",
        "page was rendered against, not necessarily the one on your stand.",
        "",
        "## Roster",
        "",
        f"{len(doc['personas'])} people, all but one in the default tenant. The",
        "exception is `other_tenant_lead`, who exists ONLY so cross-tenant refusal",
        "has a caller to refuse — no team, no org-chart edge, no activity, so they",
        "cannot appear in another persona's subtree or move a metric.",
        "",
        "`uuid` is both the Keycloak user id and the",
        "`identity.persons` person id, so a login and an API row refer to the same",
        "person.",
        "",
    ]

    lines += _table(
        ["email", "display_name", "team", "role", "realm roles", "uuid"],
        [
            [
                f"`{p['email']}`",
                _cell(p["display_name"]),
                _cell(p["team"]),
                _cell(p["role"]),
                _cell(p["realm_roles"]),
                f"`{p['uuid']}`",
            ]
            for p in doc["personas"]
        ],
    )

    lines += [
        "",
        "No password appears here or in `manifest.json`. Personas are referenced",
        "by identity; the shared local login secret lives in the compose env and",
        "the generated Keycloak realm.",
        "",
        "## Fixtures",
        "",
        "Stable names a test declares its data requirements against. The names are",
        "a contract — they describe a role in the org, not a particular person — so",
        "renaming one breaks every test that declares it.",
        "",
    ]

    lines += _table(
        ["fixture", "email", "team", "role", "uuid"],
        [
            [
                f"`{name}`",
                f"`{f['email']}`",
                _cell(f["team"]),
                _cell(f["role"]),
                f"`{f['uuid']}`",
            ]
            for name, f in sorted(doc["fixtures"].items())
        ],
    )

    lines += [
        "",
        "## Capabilities",
        "",
    ]
    lines += _table(
        ["capability", "value"],
        [[f"`{k}`", _cell(v)] for k, v in sorted(doc["capabilities"].items())],
    )
    lines += [
        "",
        "`ingestion: no` — compose seeds the silver and gold layers directly; no",
        "connector runs, so the ingestion path is not exercised on this stand.",
        "",
        "`service_principals: yes` — the authenticator's token listener is published,",
        "so a runner can exchange an RFC 7523 assertion for a service principal and",
        "exercise the `/internal/*` routes only a service may call. A stand that",
        "keeps that listener in-cluster reports `no`, and those tests skip with a",
        "reason rather than failing.",
        "",
        "`connector_schedules: no` — the seed does not write the scratch connector",
        "instance that the schedule tests edit. `./dev-compose.sh test-stand up`",
        "inserts it and reports `yes`. On a stand without it, those tests skip with",
        "a reason.",
        "",
        "`idp` reflects the environment the seed was run with. This page is",
        "rendered against a canonical environment, so it shows the default rather",
        "than your stand's value — read `manifest.json` for what is actually",
        "running.",
        "",
        "`custom_catalogue: yes` — the `analytics` step wrote the custom catalogue",
        "below into the insight-v3-core database that `MARIADB_V3_DB` names. The",
        "four `portal_*` capabilities follow it: each catalogue page has at least",
        "one seeded definition to open. A stand without that variable reports `no`",
        "for all five, and the tests that need them skip with a reason.",
        "",
    ]
    lines += _catalogue(doc.get("custom_catalogue"))

    return "\n".join(lines)


def _catalogue(doc: Any) -> list[str]:
    if not doc:
        return []

    lines = [
        "## Custom catalogue",
        "",
        "Seeded dashboards, by the stable key a test declares. Each board tests one",
        "thing a dashboard renderer must get right. The admin operator owns every",
        "board, so sign in as `admin_operator` to see all of them. The CEO sees",
        "only the shared board. Open a board at its path on the stand.",
        "",
    ]
    lines += _table(
        ["key", "name", "path", "widgets", "covers"],
        [
            [
                f"`{key}`",
                board["name"],
                f"`{board['path']}`",
                str(len(board["widgets"])),
                board["covers"],
            ]
            for key, board in doc["dashboards"].items()
        ],
    )
    lines += [
        "",
        f"The folder is `{doc['folder']}` and the dataset is `{doc['dataset']}`. A",
        "failing widget fails on purpose: its metric reads a column that the table",
        "does not have. No metric value in the catalogue is an expected value.",
        "",
    ]
    return lines


def write_profile(doc: manifest.Manifest, path: Path | None = None) -> Path:
    target = path or profile_path()
    target.write_text(render_profile(doc), encoding="utf-8", newline="\n")
    return target
