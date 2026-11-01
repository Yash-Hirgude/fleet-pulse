FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4000 4001

ENV PORT=4000
ENV SECONDARY_PORT=4001

CMD ["npm", "start"]