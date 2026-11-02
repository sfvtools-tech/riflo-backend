#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg ffmpeg fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-cjk nginx python3-venv python3-pip iptables sudo
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs=24.22.2-1nodesource1
apt-mark hold nodejs
python3 -m venv /opt/certbot
/opt/certbot/bin/pip install 'certbot>=5.4,<6'
id riflo || useradd --system --create-home --home-dir /var/lib/riflo --shell /usr/sbin/nologin riflo
install -d -o root -g riflo -m 0750 /etc/riflo
install -d -o root -g root -m 0755 /opt/riflo/releases /var/www/letsencrypt
cat > /etc/nginx/sites-available/riflo <<'NGINX'
server {
 listen 80 default_server;
 server_name _;
 location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
 location / { return 503; }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/riflo /etc/nginx/sites-enabled/riflo
nginx -t
systemctl enable --now nginx
systemctl reload nginx
touch /var/lib/riflo/bootstrap-complete

fc-cache -f
# The accepted manifest must live outside riflo's writable home.
install -d -o root -g riflo -m 0750 /etc/riflo
manifest=$(mktemp /etc/riflo/.caption-font-packages.XXXXXX)
trap 'rm -f -- "$manifest"' EXIT
dpkg-query -W '-f=${Package}\t${Version}\n' fonts-noto-core fonts-noto-cjk > "$manifest"
chown root:riflo "$manifest"
chmod 0640 "$manifest"
mv -fT -- "$manifest" /etc/riflo/caption-font-packages.tsv
