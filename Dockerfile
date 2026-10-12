# Build stage (better-sqlite3 13 requires Node >= 22)
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Runtime stage
FROM node:22-alpine

# Install tini for proper signal handling
RUN apk add --no-cache tini

WORKDIR /app

# Copy dependencies and source
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

# Create data and config directories
RUN mkdir -p /data /config

# Use non-root user for security
RUN addgroup -S homelert && adduser -S homelert -G homelert \
    && chown -R homelert:homelert /app /data /config

USER homelert

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
