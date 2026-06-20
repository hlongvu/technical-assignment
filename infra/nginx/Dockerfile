FROM nginx:1.27-alpine

# Build context is the project root (see docker-compose.yml).
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY apps/web/ /usr/share/nginx/html/
