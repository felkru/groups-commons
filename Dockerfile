# Debian 13: its poppler and cairo write the SVG form the PDF converter was verified with.
FROM node:22-trixie-slim

# pdftoppm renders pages of uploaded PDFs as preview images; LibreOffice turns Office files into PDFs for the same purpose.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils libreoffice-impress libreoffice-writer libreoffice-calc fonts-liberation fonts-dejavu-core fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Optional dependencies stay in: sharp (thumbnails) ships as a prebuilt optional package.
RUN npm ci --omit=dev --include=optional --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY public ./public
COPY cli ./cli
COPY skill ./skill
COPY docs ./docs

USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
