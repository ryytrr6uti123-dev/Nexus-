FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=4173
ENV NEXUS_BASE_PATH=/Nexus/IXLearning
ENV NEXUS_DATA_DIR=/data

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 4173
CMD ["npm", "run", "preview"]
