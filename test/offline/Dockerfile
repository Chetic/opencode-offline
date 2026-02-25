FROM --platform=linux/amd64 registry.access.redhat.com/ubi9/ubi-minimal:9.5

# Install minimal packages needed for testing
# Note: curl-minimal is pre-installed in ubi-minimal and sufficient for test assertions.
RUN microdnf install -y \
    glibc \
    libstdc++ \
    procps-ng \
    findutils \
    tar \
    git-core \
    shadow-utils \
  && microdnf clean all

# Copy the offline bundle
COPY dist/opencode-offline-linux-x64/ /opt/opencode/

# Copy test script
COPY test/offline/test-offline.sh /opt/opencode/test-offline.sh
RUN chmod +x /opt/opencode/test-offline.sh

# Create non-root user
RUN useradd -m -s /bin/bash opencode

# Set up workspace with a git repo
RUN mkdir -p /home/opencode/workspace \
  && chown -R opencode:opencode /home/opencode/workspace

USER opencode
WORKDIR /home/opencode/workspace

RUN git init && git config user.email "test@test.com" && git config user.name "Test"

# Set offline environment variables
ENV OPENCODE_OFFLINE_MODE=true
ENV OPENCODE_OFFLINE_DEPS_PATH=/opt/opencode/deps
ENV OPENCODE_DISABLE_AUTOUPDATE=true
ENV OPENCODE_DISABLE_LSP_DOWNLOAD=true
ENV OPENCODE_DISABLE_MODELS_FETCH=true

ENTRYPOINT ["/opt/opencode/opencode-offline"]
