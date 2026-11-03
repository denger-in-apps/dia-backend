# ---- dev: dipakai docker-compose lokal (hot reload, devDependencies, migrasi ts-node)
FROM node:22-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ---- build: kompilasi TypeScript ke dist/
FROM dev AS build
RUN npm run build && npm prune --omit=dev

# ---- prod: hanya dependency runtime + dist, berjalan sebagai user non-root
FROM node:22-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
