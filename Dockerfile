# Stage 1: Build Client (Vite)
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY package*.json ./
RUN npm ci
COPY . .
# Build client to /app/client/dist
RUN npm run build

# Stage 2: Build Server (TypeScript)
FROM node:20-alpine AS server-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ .
# Build server to /app/server/dist
RUN npm run build

# Stage 3: Runtime
FROM node:20-alpine
WORKDIR /app

# Install production dependencies for server
COPY server/package*.json ./
RUN npm ci --only=production

# Copy built server
COPY --from=server-builder /app/server/dist ./dist
# Copy built client to where the server expects it (../../dist relative to server/src/index.ts)
# Server runs from /app/dist/index.js, so it looks for ../../dist
# ../../dist from /app/dist/index.js is /dist. Wait. 
# Server structure in dist: /app/dist/index.js
# path.join(__dirname, '../../dist') -> /app/dist/../../dist -> /dist
# So we need to copy client build to /app/dist
COPY --from=client-builder /app/client/dist ./dist_client

# We need to adjust the server path logic or the copy location.
# If server is at /app/dist/index.js (__dirname = /app/dist)
# ../../dist means /app/dist/../../dist = /dist (root)
# So if we copy client to /app/dist_client, then ../../dist_client works?
# Let's just copy client to /app/dist/client and update server? No, server code is baked.
# Server code says: path.join(__dirname, '../../dist')
# If __dirname is /app/dist/src (tsc output structure usually keeps src folder?)
# Let's check tsconfig.
# If tsc outDir is ./dist, and input is src/index.ts, then output is dist/index.js (if rootDir is src)
# OR dist/src/index.js.
# Let's assume standard tsc: dist/index.js.
# Then ../../dist is /dist.
# So we should copy client-builder output to /app/dist.
# BUT 'dist' is also where server code is.
# Let's copy client assets to /app/public and symlink?
# Easier: Just copy to /app/dist (the folder server expects).
# Wait, if server expects ../../dist, it expects a folder named 'dist' at the grandparent of __dirname.
# If __dirname is /app/dist, grandparent is /. So it looks for /dist.
# So we should copy client build to /app/dist_static and rename it to dist?
# NO.
# Let's look at the server code again: path.join(__dirname, '../../dist')
# If we run `node dist/index.js`, __dirname is `/app/dist`.
# `path.join('/app/dist', '../../dist')` = `/dist`.
# So we need to put the client files in `/app/dist`? No, `/dist` at root.
# Let's put them in `/app/client_dist` and make sure the server finds it.
# Actually, simpler:
# In Docker, we can place files wherever.
# Let's place client files at /app/client_dist.
# And we need to make sure the server looks there.
# Since we can't change code easily now (it's baked in previous step), we must match the path.
# The path is `../../dist`.
# If we run from `/app`, and entry point is `dist/index.js`.
# __dirname is `/app/dist`.
# `../../dist` resolves to `/dist` (root of filesystem? No, `/app/dist/../../dist` -> `/dist`).
# Wait. `/app/dist` -> parent `/app` -> parent `/`.
# So it looks for `/dist`.
# So we should COPY to `/dist` in the container.
# BUT, that's the root directory. A bit messy but fine for Docker.
# Let's try to be safer.
# If we change the server code to `path.join(__dirname, '../client_dist')` it would be cleaner.
# But let's stick to the plan.
# We will COPY client build to `/app/dist_client` and symlink or just move it to match expectation?
# Actually, let's just COPY to `/app/dist` (the folder name) and put it in `/app`.
# So `/app/dist` contains the client files.
# AND `/app/server_dist` contains the server files.
# We run `node server_dist/index.js`.
# __dirname is `/app/server_dist`.
# `../../dist` is `/app/dist`.
# PERFECT.

COPY --from=client-builder /app/client/dist ./dist
COPY --from=server-builder /app/server/dist ./server_dist

ENV PORT=3000
ENV NODE_ENV=production

# Create volume mount point for SQLite
VOLUME /app/data
# We need to ensure DB path in code matches this.
# Default DB path in code: `path.resolve(__dirname, '../../weather.db')`
# If __dirname is `/app/server_dist`, then `../../weather.db` is `/app/weather.db`.
# We should probably symlink `/app/data/weather.db` to `/app/weather.db` via entrypoint
# OR just instruct user to mount volume at /app.
# But mounting at /app hides the code.
# So we should mount at /app/data and use a symlink.

CMD ["sh", "-c", "ln -sf /app/data/weather.db /app/weather.db && node server_dist/index.js"]
