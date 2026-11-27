from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

LIBRARY = Path(__file__).resolve().parents[1] / "lib/airbyte.sh"


@pytest.mark.parametrize("action", ["create", "update"])
def test_source_tokens_reach_python_on_stdin(tmp_path: Path, action: str) -> None:
    binary = tmp_path / "python3"
    args = tmp_path / "argv"
    binary.write_text(
        f'#!/bin/bash\nprintf \'%s\\0\' "$@" >> {shlex.quote(str(args))}\nexec {shlex.quote(sys.executable)} "$@"\n'
    )
    binary.chmod(0o755)
    source = {"token": 'example-token-with-spaces and quotes "'}
    configuration = tmp_path / "source.json"
    configuration.write_text(json.dumps(source))
    command = (
        'ab_create_source "example-workspace" "example-definition" "example-source" "$config"'
        if action == "create"
        else 'ab_update_source "example-source-id" "$config" "example-source"'
    )
    script = f"""
    set -euo pipefail
    export AIRBYTE_URL=http://example.test
    source {shlex.quote(str(LIBRARY))}
    config="$(cat "$1")"
    ab__curl() {{ printf '%s\n%s' "$2" "$3"; }}
    {command}
    """
    result = subprocess.run(
        ["bash", "-c", script, "example", str(configuration)],
        env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"},
        capture_output=True,
        check=True,
        text=True,
    )

    assert b"example-token-with-spaces" not in args.read_bytes()
    endpoint, payload = result.stdout.split("\n", 1)
    assert endpoint == f"/api/v1/sources/{action}"
    assert json.loads(payload)["connectionConfiguration"] == source
