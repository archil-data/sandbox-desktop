# Prebuilt desktop image. Build from this directory:
#   docker buildx build --platform linux/amd64,linux/arm64 -t <ref> image/
# Also works FROM debian:trixie (not -slim, which fails to boot on Archil today).
FROM ubuntu:26.04
COPY . /tmp/archil-desktop/
RUN sh /tmp/archil-desktop/install.sh && rm -rf /tmp/archil-desktop
