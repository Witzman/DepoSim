# Placeholder. The scope is not set, so this ships the one thing that can be
# verified without it: that push, Dokploy, Traefik, Apache and the browser
# carry bytes end to end. Replaced by the real app.
FROM nginx:1.27-alpine
COPY public/ /usr/share/nginx/html/
EXPOSE 80
