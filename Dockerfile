FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

# Keep the multi-language runtime image under Cloudflare's container image limit.
# --no-install-recommends avoids GUI/desktop/docs packages that are unnecessary
# for a headless web IDE, and the headless JDK saves additional space.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-client \
    nodejs \
    npm \
    openjdk-17-jdk-headless \
    gcc \
    g++ \
    golang-go \
    rustc \
    cargo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* /var/cache/apt/*
