# The Invariant proxy, for providers whose API is not written in Node.
#
# Distroless and non-root: no shell, no package manager, nothing but Node and
# one bundled file, which `pnpm bundle:sidecar` writes before this is built.
# The base is pinned by digest so the image is the same image every time it is
# built from the same commit.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

LABEL org.opencontainers.image.title="invariant-sidecar" \
      org.opencontainers.image.description="Serves every old contract of an API from the current one, as a reverse proxy." \
      org.opencontainers.image.source="https://github.com/InvariantApp/Invariant" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --chown=65532:65532 bundle/invariant-sidecar.js /app/invariant-sidecar.js
COPY LICENSE NOTICE /app/

# The configuration and the compiled program are the provider's, mounted in.
ENV INVARIANT_SIDECAR_CONFIG=/etc/invariant/sidecar.json
USER 65532:65532
EXPOSE 8080

# Asks the proxy itself. Set INVARIANT_HEALTH_URL when the configuration moves
# the port or the health path away from their defaults.
ENV INVARIANT_HEALTH_URL=http://127.0.0.1:8080/__invariant/health
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch(process.env.INVARIANT_HEALTH_URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["/app/invariant-sidecar.js"]
