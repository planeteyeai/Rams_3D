# Use the official Node.js runtime as base image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (skip optional dependencies to avoid platform-specific packages)
RUN npm ci --omit=dev --no-optional

# Copy the rest of the application code
COPY . .

# Build the application
RUN npm run build

# Expose port 4173 for preview mode
EXPOSE 4173

# Start the application in preview mode
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0"]
