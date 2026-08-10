# L1/L2 Audit — ops.health.containers bridge

## L1 Design
Consensus: use console's existing Docker socket (no new privileges, no cAdvisor dependency).

## L2 Implementation  
- duneDb.js: addonOpsContainerHealth() — docker stats --no-stream, try/catch fallback
- server.js: bridge route with ops:read permission + audit logging
- Returns per-container {name, cpu, mem, memLimit, netIO, blockIO, status}

## Findings
0 CRITICAL, 0 HIGH — simple additive feature following existing bridge pattern.
