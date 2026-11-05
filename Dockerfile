FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3000 TRADELENS_DB=/data/tradelens.sqlite
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.mjs"]
