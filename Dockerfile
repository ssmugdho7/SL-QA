# Playwright image ships Chromium and its system libraries; keep the tag in step with package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
ENV NODE_ENV=production PORT=4100
COPY package.json package-lock.json ./
# tsx, dotenv and playwright are devDependencies, so install everything.
RUN npm ci --include=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
# Render free has no disk, so /storage is just a folder there; elsewhere mount a volume on it.
RUN mkdir -p /storage && ln -s /storage/data data && ln -s /storage/runs runs && ln -s /storage/.auth .auth
EXPOSE 4100
CMD ["sh", "-c", "mkdir -p /storage/data /storage/runs /storage/.auth && exec npx tsx src/web/server.ts"]
