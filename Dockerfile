# Team server. Teammates point their hooks here with:
#   agent-office install --url https://your-host:4380 --token <token>
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY hooks ./hooks
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=4380 AGENT_OFFICE_DIR=/data
VOLUME ["/data"]
EXPOSE 4380
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4380/healthz || exit 1
CMD ["node", "bin/agent-office.js", "start"]
