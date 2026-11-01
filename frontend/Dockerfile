# Stage 1: Build Angular dist assets
FROM node:20-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build -- --configuration production

# Stage 2: Minimal static file server
FROM node:20-alpine

WORKDIR /app

RUN npm install -g serve

COPY --from=build /app/dist/fleet-pulse/browser ./public

EXPOSE 4200

CMD ["serve", "-s", "public", "-l", "4200"]