FROM node:18-slim

# Instalamos las dependencias de sistema que necesita Puppeteer (Chrome) para correr en Linux
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Creamos el directorio de trabajo
WORKDIR /usr/src/app

# Copiamos package.json e instalamos dependencias de Node
COPY package*.json ./
RUN npm install

# Copiamos el código fuente
COPY . .

# Exponemos el puerto 8080 (Obligatorio para Google Cloud Run)
EXPOSE 8080

# Comando para iniciar el bot
CMD [ "node", "index.js" ]
