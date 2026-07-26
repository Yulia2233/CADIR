FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.18.3

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENCODE_CONFIG=/app/opencode.json \
    OPENCODE_CONFIG_DIR=/app/.opencode \
    CADIR_RUNNER_PATH=/app/cad-runtime/cadir_runner.py \
    CADIR_PYTHON=/usr/bin/python3 \
    CADIR_FREECAD_CMD=/usr/bin/freecadcmd \
    CADIR_JOBS_ROOT=/workspace/jobs

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        freecad \
        python3 \
        python3-matplotlib \
        python3-pip \
        tini \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "opencode-ai@${OPENCODE_VERSION}"

ARG CADIR_SOURCE_COMMIT=787a77df93dc446b5d9fb01e7fe2f615d3433334
ARG CADIR_SOURCE_SHA256=9D313F4F49EC2F76C3067654DB998155C3AA8C9C2AF67BB28EF2A0F49394A64F
COPY SimpleCADAPI-master.zip /tmp/CADIR-dev.zip
COPY --from=figure3_simplecadapi src/simplecadapi/translator/freecad_translator /tmp/figure3-freecad-translator
COPY --from=figure3_simplecadapi src/simplecadapi/translator/base.py /tmp/figure3-translator-base.py
COPY --from=figure3_simplecadapi src/simplecadapi/translator/canonical_ops.py /tmp/figure3-canonical-ops.py
RUN mkdir -p /opt/simplecadapi \
    && printf '%s  %s\n' "$CADIR_SOURCE_SHA256" /tmp/CADIR-dev.zip | sha256sum -c - \
    && unzip -q /tmp/CADIR-dev.zip -d /opt/simplecadapi \
    && test -f /opt/simplecadapi/CADIR-dev/pyproject.toml \
    && rm -rf /opt/simplecadapi/CADIR-dev/src/simplecadapi/translator/freecad_translator \
    && cp -a /tmp/figure3-freecad-translator /opt/simplecadapi/CADIR-dev/src/simplecadapi/translator/freecad_translator \
    && cp /tmp/figure3-translator-base.py /opt/simplecadapi/CADIR-dev/src/simplecadapi/translator/base.py \
    && cp /tmp/figure3-canonical-ops.py /opt/simplecadapi/CADIR-dev/src/simplecadapi/translator/canonical_ops.py \
    && python3 -m pip install --break-system-packages --no-cache-dir \
        /opt/simplecadapi/CADIR-dev \
    && printf '%s\n' "$CADIR_SOURCE_COMMIT" > /opt/simplecadapi/CADIR-dev/SOURCE_COMMIT \
    && printf '%s\n' "${CADIR_SOURCE_COMMIT}+figure3-freecad-translator" > /opt/simplecadapi/CADIR-dev/FREECAD_TRANSLATOR_SOURCE \
    && rm -rf /tmp/figure3-freecad-translator \
    && rm /tmp/figure3-translator-base.py \
    && rm /tmp/figure3-canonical-ops.py \
    && rm /tmp/CADIR-dev.zip

RUN groupadd --gid 10001 cadir \
    && useradd --uid 10001 --gid cadir --create-home --shell /usr/sbin/nologin cadir \
    && mkdir -p /app /workspace/jobs /home/cadir/.local/share/opencode \
    && chown -R cadir:cadir /app /workspace /home/cadir

WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/So3Lab/CADIR" org.opencontainers.image.revision="$CADIR_SOURCE_COMMIT"
COPY --chown=cadir:cadir opencode.json /app/opencode.json
COPY --chown=cadir:cadir .opencode /app/.opencode
COPY --chown=cadir:cadir cad-runtime /app/cad-runtime

USER cadir
EXPOSE 4096
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD curl -fsS -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/global/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
