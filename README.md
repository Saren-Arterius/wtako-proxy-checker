# Proxy Verifier (Bun)

This vibe-coded project verifies HTTP, SOCKS5, and SOCKS4 proxies and exports valid results to a unified CSV file.

## What it does

`verify.ts`:

1. Downloads proxy lists from:
   - `http`
   - `socks5`
   - `socks4`
2. Merges with an alternate proxy source.
3. Deduplicates proxies per protocol.
4. Checks each proxy with two requests:
   - `https://arch-mirror.wtako.net/lastupdate` (CF security off, required to pass)
   - `https://saren.wtako.net/ip.php` (CF security normal, best-effort IP detection)
5. Enforces a **60s total timeout budget per proxy** for the two requests combined.
6. Writes valid proxies to:

- `valid/proxies.csv`

CSV format:

```csv
protocol,ip_port,latency,ip
```

- `protocol`: `http`, `socks5`, or `socks4`
- `ip_port`: proxy endpoint
- `latency`: seconds for successful `lastupdate` check
- `ip`: detected external IP from `ip.php`, or `local-ip-unavailable`

---

## Requirements

- [Bun](https://bun.sh/) installed
- `curl` available in PATH (used for SOCKS checks)

---

## Run

```bash
bun verify.ts
```

---

## Output

After running, check:

```bash
valid/proxies.csv
```

You will also see live logs in terminal:

- Success examples:
  - `[OK][http] 1.2.3.4:8080 lastupdate=0.42s ip=8.8.8.8`
  - `[OK][socks5] 5.6.7.8:1080 lastupdate=1.12s ip=local-ip-unavailable`
- Failure examples:
  - `[FAIL][socks4] 9.9.9.9:1080 -> timeout`
  - `[FAIL][socks5] 7.7.7.7:1080 -> HTTP 000`

---

## Notes

- A proxy is considered valid only if the `lastupdate` request succeeds.
- `ip.php` may fail while the proxy is still accepted; in that case `ip` is set to `local-ip-unavailable`.
- SOCKS checks are performed via `curl` for compatibility.

## Credits

Proxy source data references:

- https://github.com/proxifly/free-proxy-list
- https://github.com/TheSpeedX/PROXY-List
