FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/providers /app/.cache \
  && chown -R node:node /app/providers /app/.cache

ENV NODE_ENV=production
EXPOSE 3000

USER node

CMD ["npm", "start"]
