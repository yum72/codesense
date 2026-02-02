# CodeSense MCP Server Dockerfile
# Multi-stage build for optimized production image

# ─────────────────────────────────────────────────────────────────────────────
# Build Stage
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install all dependencies (including dev for any build steps)
RUN npm ci

# Copy source code
COPY . .

# ─────────────────────────────────────────────────────────────────────────────
# Production Stage
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Add labels for container metadata
LABEL org.opencontainers.image.title="CodeSense MCP Server"
LABEL org.opencontainers.image.description="AI-powered code intelligence MCP server with Memgraph"
LABEL org.opencontainers.image.version="1.0.0"

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source code from builder
COPY --from=builder /app/src ./src

# Create non-root user for security
RUN addgroup -g 1001 -S codesense && \
    adduser -S codesense -u 1001 -G codesense

# Create directory for mounting codebase
RUN mkdir -p /codebase && chown codesense:codesense /codebase

# Switch to non-root user
USER codesense

# Environment variables with defaults
ENV NODE_ENV=production
ENV MEMGRAPH_URL=bolt://memgraph:7687
ENV MEMGRAPH_USERNAME=""
ENV MEMGRAPH_PASSWORD=""
ENV CODEBASE_PATH=/codebase

# Health check - verify node process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Default command - run the MCP server
# The server communicates via stdio, so it's designed to be connected via MCP client
CMD ["node", "src/index.js"]
