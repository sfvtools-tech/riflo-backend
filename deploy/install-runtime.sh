#!/usr/bin/env bash
# Run as root from the extracted Linux release.
set -euo pipefail
id riflo >/dev/null 2>&1 || useradd --system --home /opt/riflo --shell /usr/sbin/nologin riflo
install -d -m 0755 /opt/riflo/releases /etc/riflo
install -o root -g root -m 0755 deploy/network/riflo-source-network.sh /usr/local/sbin/riflo-source-network
install -o root -g root -m 0755 deploy/network/riflo-ytdlp-root /usr/local/sbin/riflo-ytdlp-root
install -o root -g root -m 0755 deploy/network/riflo-ytdlp /usr/local/bin/riflo-ytdlp
printf 'riflo ALL=(root) NOPASSWD: /usr/local/sbin/riflo-ytdlp-root *\n' > /etc/sudoers.d/riflo-source
chmod 0440 /etc/sudoers.d/riflo-source
visudo -cf /etc/sudoers.d/riflo-source
install -m 0644 deploy/systemd/riflo-source-network.service deploy/systemd/riflo@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now riflo-source-network.service
