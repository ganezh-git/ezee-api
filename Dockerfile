FROM node:22-slim

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json* ./

# Install all deps (including devDependencies for build)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript (transpile-only, skip type checking for speed)
RUN npx esbuild src/server.ts --bundle --platform=node --outfile=dist/server.js --packages=external --format=cjs

# Remove devDependencies
RUN npm prune --production

# Expose port
ENV PORT=8080
EXPOSE 8080

# Start
CMD ["node", "dist/server.js"]
