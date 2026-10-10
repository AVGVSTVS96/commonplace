FROM docker.io/oven/bun:1-slim AS bun

FROM docker.io/library/debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tigervnc-standalone-server \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
  && curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  && apt-get install -y --no-install-recommends /tmp/chrome.deb \
  && rm -rf /tmp/chrome.deb /var/lib/apt/lists/* \
  && mkdir /opt/novnc \
  && curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.7.0.tar.gz | tar -xz -C /opt/novnc --strip-components 1 \
  && mkdir -m 1777 -p /tmp/.X11-unix \
  && useradd --create-home --shell /bin/bash computer

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY box.ts /opt/computer/box.ts

USER computer
WORKDIR /home/computer
EXPOSE 8080
CMD ["bun", "/opt/computer/box.ts"]
