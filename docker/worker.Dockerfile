ARG RUST_TOOLCHAIN=1.99.1
FROM rust:${RUST_TOOLCHAIN}-trixie
ARG GRAPHIFY_VERSION=0.9.92
# RTK's integration tests assert on real git output and are verified against current git (upstream CI runs the
# latest stable). Debian's git fails some of them (2.39: guard_integration_test; 2.47: git_log_cap_notice_test),
# so a pinned upstream git is built into /usr/local, ahead of the distro git on PATH. jq is needed by the hook tests.
ARG GIT_VERSION=2.56.0
ARG GIT_SHA256=26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential pkg-config libssl-dev ripgrep jq ca-certificates curl xz-utils libcurl4-openssl-dev libexpat1-dev zlib1g-dev && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/git.tar.xz https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz \
 && echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/git.tar.xz -C /tmp \
 && make -C /tmp/git-${GIT_VERSION} -j"$(nproc)" prefix=/usr/local NO_TCLTK=1 NO_GETTEXT=1 install >/dev/null \
 && rm -rf /tmp/git.tar.xz /tmp/git-${GIT_VERSION} && git --version
RUN rustup component add rustfmt clippy
RUN python3 -m venv /opt/graphify && /opt/graphify/bin/pip install --no-cache-dir graphifyy==${GRAPHIFY_VERSION}
ENV PATH="/opt/graphify/bin:${PATH}" CARGO_HOME=/opt/cargo CARGO_TARGET_DIR=/build/target CARGO_BUILD_JOBS=1
RUN mkdir -p /workspace /build/target /build/graphify-out /opt/cargo && cp -a /usr/local/cargo/bin /opt/cargo/bin
COPY docker/prepare.py /opt/bugfix/prepare.py
WORKDIR /workspace
CMD ["sleep", "infinity"]
