FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The API is served from the same origin under /api (see nginx.conf), and
# the screen shield is always on in production builds.
ENV VITE_API_BASE=/api VITE_SCREEN_SHIELD=on
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.inc /etc/nginx/conf.d/security-headers.inc
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
