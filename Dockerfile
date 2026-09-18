# Multi-stage build
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Remove problematic Windows dependency and install
RUN npm pkg delete dependencies.lightningcss-win32-x64-msvc && \
    npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install serve to host the built files
RUN npm install -g serve

# Copy built files from builder stage
COPY --from=builder /app/dist /app

# Expose port 3000
EXPOSE 3000

# Start the application
CMD ["serve", "-s", "/app", "-l", "3000"]
