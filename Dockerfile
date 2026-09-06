FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

# The Cloudflare Python sandbox image already includes Node.js, npm, Bun,
# Python, pip and common development utilities. Do not reinstall Node/npm:
# doing so pulls a large Ubuntu dependency tree and makes cold starts slower.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-client \
    openjdk-17-jdk-headless \
    gcc \
    g++ \
    golang-go \
    rustc \
    cargo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* /var/cache/apt/*
