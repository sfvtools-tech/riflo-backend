#!/usr/bin/env bash
# YouTube uses one fixed IPv6 address; application traffic retains IPv4.
set -euo pipefail
ip netns list | grep -q '^riflo-source ' || ip netns add riflo-source
for family in iptables ip6tables; do
  ip netns exec riflo-source "$family" -P OUTPUT DROP
  ip netns exec riflo-source "$family" -F OUTPUT
done
[[ $(stat -c '%u:%a' /etc/riflo/source-network.env) == 0:600 ]]
: "${SOURCE_IPV6_ADDRESS:?Missing fixed source IPv6 address}"
: "${SOURCE_IPV6_SUBNET:?Missing source IPv6 subnet}"
python3 -c 'import ipaddress,sys; a=ipaddress.IPv6Address(sys.argv[1]); n=ipaddress.IPv6Network(sys.argv[2]); assert a.is_global and n.is_global and n.prefixlen == 64 and a in n' "$SOURCE_IPV6_ADDRESS" "$SOURCE_IPV6_SUBNET"
# Guest networking can finish after boot; unavailable addressing stays fail-closed.
for attempt in {1..30}; do
  ip -6 address show dev ens4 | grep -Fq "$SOURCE_IPV6_ADDRESS/" && break
  [[ $attempt != 30 ]] || { echo 'Fixed source IPv6 address is not assigned.' >&2; exit 1; }
  sleep 1
done
append6() { ip6tables -C "$@" 2>/dev/null || ip6tables -A "$@"; }
ip6tables -N RIFLO-SOURCE-INPUT 2>/dev/null || true
append6 RIFLO-SOURCE-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for kind in destination-unreachable packet-too-big time-exceeded parameter-problem; do
  append6 RIFLO-SOURCE-INPUT -p ipv6-icmp --icmpv6-type "$kind" -j ACCEPT
done
for kind in router-advertisement neighbor-solicitation neighbor-advertisement; do
  append6 RIFLO-SOURCE-INPUT -i ens4 -p ipv6-icmp --icmpv6-type "$kind" -m hl --hl-eq 255 -j ACCEPT
done
for kind in neighbor-solicitation neighbor-advertisement; do
  append6 RIFLO-SOURCE-INPUT -i riflo-src-host -p ipv6-icmp --icmpv6-type "$kind" -m hl --hl-eq 255 -j ACCEPT
done
append6 RIFLO-SOURCE-INPUT -i ens4 -s fe80::/10 -p udp --sport 547 --dport 546 -j ACCEPT
append6 RIFLO-SOURCE-INPUT -j DROP
ip6tables -C INPUT -j RIFLO-SOURCE-INPUT 2>/dev/null || ip6tables -I INPUT 1 -j RIFLO-SOURCE-INPUT
ip6tables -C OUTPUT -m owner --uid-owner riflo -j REJECT 2>/dev/null || ip6tables -I OUTPUT 1 -m owner --uid-owner riflo -j REJECT
if ! ip link show riflo-src-host >/dev/null 2>&1; then
  ip link add riflo-src-host type veth peer name riflo-src-net
  ip link set riflo-src-net netns riflo-source
fi
ip address replace 192.0.2.1/30 dev riflo-src-host
ip -6 address replace fd42:7269:666c:1::1/64 dev riflo-src-host nodad
ip link set riflo-src-host up
ip -n riflo-source address replace 192.0.2.2/30 dev riflo-src-net
ip -n riflo-source -6 address replace fd42:7269:666c:1::2/64 dev riflo-src-net nodad
ip -n riflo-source link set riflo-src-net up
ip -n riflo-source link set lo up
ip -n riflo-source route replace default via 192.0.2.1
ip -n riflo-source -6 route replace default via fd42:7269:666c:1::1
mkdir -p /etc/netns/riflo-source
printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/netns/riflo-source/resolv.conf
# No IPv4 media fallback. DNS remains on the two public IPv4 resolvers.
ip netns exec riflo-source iptables -A OUTPUT -p udp --dport 53 -d 8.8.8.8 -j ACCEPT
ip netns exec riflo-source iptables -A OUTPUT -p udp --dport 53 -d 8.8.4.4 -j ACCEPT
for kind in neighbor-solicitation neighbor-advertisement; do
  ip netns exec riflo-source ip6tables -A OUTPUT -p ipv6-icmp --icmpv6-type "$kind" -j ACCEPT
done
for network in "$SOURCE_IPV6_SUBNET" 2001::/23 2001:db8::/32 2002::/16 3fff::/20; do
  ip netns exec riflo-source ip6tables -A OUTPUT -d "$network" -j REJECT
done
ip netns exec riflo-source ip6tables -A OUTPUT -d 2000::/3 -p tcp -m multiport --dports 80,443 -j ACCEPT
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv6.conf.ens4.accept_ra=2
sysctl -w net.ipv6.conf.all.forwarding=1
iptables -t nat -C POSTROUTING -s 192.0.2.2/32 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 192.0.2.2/32 -j MASQUERADE
iptables -C FORWARD -i riflo-src-host -j ACCEPT 2>/dev/null || iptables -A FORWARD -i riflo-src-host -j ACCEPT
iptables -C FORWARD -o riflo-src-host -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || iptables -A FORWARD -o riflo-src-host -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -t nat -C POSTROUTING -s fd42:7269:666c:1::2/128 -o ens4 -j SNAT --to-source "$SOURCE_IPV6_ADDRESS" 2>/dev/null || ip6tables -t nat -A POSTROUTING -s fd42:7269:666c:1::2/128 -o ens4 -j SNAT --to-source "$SOURCE_IPV6_ADDRESS"
append6 FORWARD -i riflo-src-host -j ACCEPT
append6 FORWARD -o riflo-src-host -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
