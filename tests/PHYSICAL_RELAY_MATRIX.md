Canonical copy: docs/PHYSICAL_RELAY_MATRIX.md
# Physical relay certification matrix

Use ≥2 Android devices with `assembleDebug` build.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | Offline emergency stored | Queue shows PENDING, not lost |
| 2 | A→B→gateway | Desk receives; hop count correct |
| 3 | A→B→C→gateway | Hop ≤ 6; Relay strip |
| 4 | Duplicate packet | Single incident / dedup |
| 5 | Tampered payload | Rejected, no forward |
| 6 | Invalid signature | Rejected |
| 7 | Expired packet | Not forwarded; purged |
| 8 | Hop > 6 | Dead-letter / reject |
| 9 | Wrong institution | Rejected at gateway |
| 10 | App kill during SENDING | Recovers to PENDING |
| 11 | BLE interrupt mid-transfer | Retry; no delete without ACK |
| 12 | Wi-Fi interrupt | Retry; ACK required |
| 13 | Gateway down then up | Drain after recovery |
| 14 | Revoked device | Rejected |
| 15 | Screen lock / battery saver | Queue preserved |

Sign-off: date, devices, OS versions, tester name.
