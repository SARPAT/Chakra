FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy parent package (chakra-middleware) for file:.. dependency
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
COPY dist/ ./dist/

# Copy demo into its own directory
COPY demo/ ./demo/

WORKDIR /app/demo
RUN npm install --production

EXPOSE 3000 4242

CMD ["node", "app.js"]
