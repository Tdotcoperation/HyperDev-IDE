FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

RUN apt-get update && apt-get install -y \
    openssh-client \
    nodejs \
    npm \
    openjdk-17-jdk \
    gcc \
    g++ \
    golang-go \
    rustc \
    cargo \
    && rm -rf /var/lib/apt/lists/*
