# WORKAROUND: pip ignores [tool.uv]. Install the hashed export of uv.lock, the resolution CI tests.
FROM ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc AS lock
WORKDIR /src
COPY pyproject.toml uv.lock ./
RUN ["/uv", "export", "--frozen", "--no-dev", "--no-emit-project", "--output-file", "/requirements.txt"]

FROM airbyte/python-connector-base:4.1.1@sha256:a268b44c733ae699a60f5fbc06a324945dba98945c6e2ab7f8609f2f895b0d28

# The base digest is pinned and ships no apt layer, so bookworm-security updates
# only reach the image if this stage applies them. Runs before the USER switch.
# Bump to re-run the upgrade when a fix lands without the base digest moving.
ARG SECURITY_EPOCH=2026-11-02
RUN echo "security epoch ${SECURITY_EPOCH}" \
    && apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY --from=lock /requirements.txt /tmp/requirements.txt
# INVARIANT: uv.lock replaces flagged base packages: nltk (override of the CDK pin), cryptography, urllib3.
# WORKAROUND: pip cannot apply the nltk override, so the full closure installs with --no-deps.
RUN pip install --no-cache-dir --no-deps --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY . /airbyte/integration_code
# poetry 1.8.4 and dulwich 0.21.7 are base-image build tooling unused at runtime
# (CVE-2026-34591, CVE-2026-42305); so are the packages only poetry needs:
# virtualenv (CVE-2026-113718 and 10 more), filelock (CVE-2026-112940; the CDK's
# pyrate-limiter wants it only as an extra) and msgpack (CVE-2026-114613), with
# CacheControl and poetry-plugin-export that hold them.
# pip check accepts only the nltk override conflict; any other line fails the build.
RUN pip install --no-cache-dir --no-deps --no-build-isolation /airbyte/integration_code \
    && pip uninstall -y poetry dulwich poetry-plugin-export cachecontrol virtualenv filelock msgpack \
    && ! pip check --no-cache-dir 2>&1 | grep -v \
        -e '^No broken requirements found\.$' \
        -e '^airbyte-cdk [^ ]* has requirement nltk==3\.9\.4, but you have nltk 3\.10\.4\.$'

RUN useradd --create-home --no-log-init --shell /bin/bash airbyte_user
USER airbyte_user

ENV AIRBYTE_ENTRYPOINT="source-active-directory"
ENTRYPOINT ["source-active-directory"]
