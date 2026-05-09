FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
