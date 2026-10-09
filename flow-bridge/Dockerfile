FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV GFLOW_CHROME_PATH=/usr/bin/google-chrome
ENV FLOW_DATA_DIR=/data
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg xvfb xauth x11vnc novnc websockify fonts-liberation tar \\
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev && npm install --global @swissmarley/gflow-cli

COPY server.js ./
RUN mkdir -p /data/out /data/jobs && chown -R node:node /data /app

USER node
EXPOSE 10000
CMD ["node", "server.js"]
