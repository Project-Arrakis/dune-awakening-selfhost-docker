# Addon Hardware Status Bridge

`server.hardware.status` exposes a bounded, read-only hardware snapshot to an enabled addon with approved `server:status` permission.

Addon request:

```js
const status = await window.DuneAddon.request("server.hardware.status");
```

The Console collects the data itself from fixed Linux interfaces. It never executes scripts, binaries, or commands supplied by an addon package.

## Response

```json
{
  "version": 1,
  "temperatures": [
    { "name": "coretemp Package id 0", "temperature": 47.5 }
  ],
  "memory": {
    "total_kb": 16777216,
    "available_kb": 8388608,
    "used_kb": 8388608,
    "percent": 50
  },
  "swap": {
    "total_kb": 4194304,
    "free_kb": 4194304,
    "used_kb": 0,
    "percent": 0
  },
  "load": { "one": 0.25, "five": 0.2, "fifteen": 0.18 },
  "uptime_seconds": 86400
}
```

Temperatures are degrees Celsius read from `/sys/class/hwmon`. Memory and swap are read from `/proc/meminfo`, load from `/proc/loadavg`, and uptime from `/proc/uptime`. Missing or unreadable sources return an empty temperature list or zero-valued section rather than failing the whole request. Temperature output is capped at 128 validated sensors.

The addon manifest must request:

```json
{
  "permissions": {
    "server": ["status"]
  }
}
```
