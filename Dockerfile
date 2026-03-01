FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY jest.config.cjs ./
COPY src ./src
COPY migrations ./migrations
COPY tests ./tests

EXPOSE 3000

CMD ["npm", "run", "dev"]
