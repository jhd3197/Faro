# The CI runner (ubuntu-22.04) with everything .github/workflows/ci.yml
# installs, so scripts/ci-local.sh can run the same steps before a push.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config gnupg \
      python3 python3-pip python3-venv \
      libssl-dev libwebkit2gtk-4.1-dev libdbus-1-dev libappindicator3-dev librsvg2-dev patchelf openssh-server \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb && rm /tmp/chrome.deb \
    && curl -fsSL https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
       | tar -xz -C /usr/local/bin actionlint \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --component clippy
RUN python3 -m pip install --no-cache-dir 'moto[server]==5.1.12' boto3
# Like the GitHub runner, run as a regular user (Chrome needs --no-sandbox as
# root, and several UI tests don't pass it). Cache dirs are created here so the
# named volumes mounted on them start out owned by that user.
RUN useradd -m runner && mkdir -p /cache /w /usr/local/cargo/registry     && chown -R runner /cache /w /usr/local/cargo /usr/local/rustup
USER runner
