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

COPY SimpleCADAPI-master.zip /tmp/SimpleCADAPI-master.zip
RUN mkdir -p /opt/simplecadapi \
    && unzip -q /tmp/SimpleCADAPI-master.zip -d /opt/simplecadapi \
    && python3 -m pip install --break-system-packages --no-cache-dir \
        /opt/simplecadapi/SimpleCADAPI-master \
    && rm /tmp/SimpleCADAPI-master.zip

RUN groupadd --gid 10001 cadir \
    && useradd --uid 10001 --gid cadir --create-home --shell /usr/sbin/nologin cadir \
    && mkdir -p /app /workspace/jobs /home/cadir/.local/share/opencode \
    && chown -R cadir:cadir /app /workspace /home/cadir

WORKDIR /app
COPY --chown=cadir:cadir opencode.json /app/opencode.json
COPY --chown=cadir:cadir .opencode /app/.opencode
COPY --chown=cadir:cadir cad-runtime /app/cad-runtime

USER cadir
EXPOSE 4096
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD curl -fsS -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/global/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
