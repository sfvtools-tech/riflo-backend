#!/bin/bash
set -euo pipefail
# Usage: RIFLO_API_IP=203.0.113.10 RIFLO_CERTBOT_EMAIL=ops@example.com bash configure-tls.sh
: "${RIFLO_API_IP:?Set RIFLO_API_IP to the server IPv4 address}"
: "${RIFLO_CERTBOT_EMAIL:?Set RIFLO_CERTBOT_EMAIL to the certificate contact email}"
ip="$RIFLO_API_IP"
if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
 echo 'RIFLO_API_IP must be an IPv4 address' >&2
 exit 1
fi
IFS=. read -r -a octets <<< "$ip"
for octet in "${octets[@]}"; do
 if (( 10#$octet > 255 )); then
  echo 'RIFLO_API_IP must be an IPv4 address' >&2
  exit 1
 fi
done
if [[ ! "$RIFLO_CERTBOT_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
 echo 'RIFLO_CERTBOT_EMAIL must be a contact email address' >&2
 exit 1
fi
/opt/certbot/bin/certbot certonly --non-interactive --agree-tos --email "$RIFLO_CERTBOT_EMAIL" --preferred-profile shortlived --webroot --webroot-path /var/www/letsencrypt --ip-address "$ip"
cat > /etc/nginx/sites-available/riflo <<NGINX
server {
 listen 80 default_server;
 server_name ${ip};
 location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
 location / { return 308 https://${ip}\$request_uri; }
}
server {
 listen 443 ssl default_server;
 server_name ${ip};
 ssl_certificate /etc/letsencrypt/live/${ip}/fullchain.pem;
 ssl_certificate_key /etc/letsencrypt/live/${ip}/privkey.pem;
 ssl_protocols TLSv1.2 TLSv1.3;
 client_max_body_size 1m;
 location / {
  proxy_pass http://127.0.0.1:4310;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Forwarded-For \$remote_addr;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header Connection '';
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
 }
}
NGINX
nginx -t
systemctl reload nginx
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\n/usr/sbin/nginx -t && /bin/systemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/nginx
cat > /etc/systemd/system/riflo-certbot-renew.service <<'UNIT'
[Unit]
Description=Renew Riflo IP TLS certificate
[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet
UNIT
cat > /etc/systemd/system/riflo-certbot-renew.timer <<'UNIT'
[Unit]
Description=Check Riflo short-lived TLS certificate every six hours
[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now riflo-certbot-renew.timer
/opt/certbot/bin/certbot renew --dry-run
