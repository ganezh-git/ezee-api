FROM node:22-slim

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json* ./

# Install all deps (including devDependencies for tsc)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Remove devDependencies
RUN npm prune --production

# Expose port
ENV PORT=8080
EXPOSE 8080

# Start
CMD ["node", "dist/server.js"]
