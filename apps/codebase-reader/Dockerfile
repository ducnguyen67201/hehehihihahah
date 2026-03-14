FROM node:20-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json turbo.json ./
COPY apps/codebase-reader/package.json apps/codebase-reader/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/env/package.json packages/env/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/database/package.json packages/database/package.json

RUN npm ci

COPY apps/codebase-reader apps/codebase-reader
COPY packages/tsconfig packages/tsconfig
COPY packages/env packages/env
COPY packages/types packages/types
COPY packages/database packages/database

RUN npm run db:generate
RUN npm run build --workspace @app/codebase-reader

CMD ["npm", "run", "start", "--workspace", "@app/codebase-reader"]
