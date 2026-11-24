from __future__ import annotations

import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import yaml

CHART = Path(__file__).resolve().parents[1]


def render() -> list[dict]:
    result = subprocess.run(
        [
            "helm",
            "template",
            "contract-test",
            str(CHART),
            "--namespace",
            "synthetic",
            "-f",
            str(CHART / "tests/values.yaml"),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def resource(documents: list[dict], kind: str, name: str) -> dict:
    return next(doc for doc in documents if doc["kind"] == kind and doc["metadata"]["name"] == name)


def test_authenticator_trusts_the_issuer_the_umbrella_mints() -> None:
    documents = render()
    secret = resource(documents, "Secret", "insight-authenticator-config")
    gateway_issuer = secret["stringData"]["APP__gears__authenticator__config__gateway_issuer"]
    config_map = resource(documents, "ConfigMap", "contract-test-authenticator-gears-config")
    plugin = yaml.safe_load(config_map["data"]["authenticator.yaml"])["gears"]["oidc-authn-plugin"]["config"]
    certificate = resource(documents, "Certificate", "contract-test-authenticator-authn-tls")

    assert plugin["jwt"]["trusted_issuers"] == [{"issuer": gateway_issuer}]
    assert plugin["s2s_oauth"]["discovery_url"] == gateway_issuer
    assert urlsplit(gateway_issuer).hostname in certificate["spec"]["dnsNames"]
