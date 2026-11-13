# Debian 13.
FROM node:22-trixie-slim

# pdftoppm (poppler) renders pages of uploaded PDFs as preview images; LibreOffice turns Office files into PDFs for the
# same purpose. The PDF -> template converter (server/convert-pdf.js) does not run here: the site serves it as a file
# and the commons CLI runs it on the organizer's computer.
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
# The one-off move from Firestore to PostgreSQL runs as a job on this image: node tools/migrate-to-postgres.mjs
COPY tools/migrate-to-postgres.mjs ./tools/

USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
