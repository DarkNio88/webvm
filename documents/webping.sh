#!/bin/sh
# webping - works inside WebVM where ICMP ping is not available
# (CheerpX does not implement raw sockets / capget, so `ping` cannot work).
# This script checks TCP/DNS connectivity instead.

usage() {
	echo "Usage: /web/webping.sh <host> [port]"
	echo "  host: hostname or IP (e.g. google.com or 1.1.1.1)"
	echo "  port: TCP port to test (default 443)"
}

host="$1"
port="${2:-443}"
[ -z "$host" ] && { usage; exit 1; }

ip=$(nslookup "$host" 2>/dev/null | awk '/^Address/ {print $NF}' | grep -v ':#' | head -n1)

if [ -n "$ip" ]; then
	echo "DNS OK: $host -> $ip"
else
	echo "DNS FAIL: cannot resolve $host"
	exit 2
fi

# busybox nc (netcat) does the real TCP reachability test
if nc -z -w 5 "$ip" "$port" 2>/dev/null; then
	echo "TCP OK: $ip:$port reachable"
	exit 0
else
	echo "TCP FAIL: $ip:$port not reachable (is Tailscale connected?)"
	exit 3
fi
