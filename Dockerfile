FROM node:18-slim

# Instalamos Chromium para que Puppeteer funcione en la nube
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Le decimos a Puppeteer que use el Chromium que acabamos de instalar
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiamos e instalamos dependencias
COPY package*.json ./
RUN npm install

# Copiamos el resto de tus archivos (server.js)
COPY . .

# Exponemos el puerto
EXPOSE 3000

# El comando que ejecutará la nube
CMD ["node", "server.js"]