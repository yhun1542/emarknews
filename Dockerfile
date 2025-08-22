FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with clean cache
RUN npm cache clean --force && \
    npm install --no-audit --no-fund

# Copy source code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 8080

# Start the application
CMD ["npm", "start"]

