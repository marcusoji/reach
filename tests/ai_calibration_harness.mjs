#!/usr/bin/env node
/**
 * Offline evaluation harness for Safety Fusion outputs.
 * Input JSONL: { evidence: [...], expected_category, expected_abstain? }
 * Does not claim calibrated probability until metrics reviewed.
 */
console.log(`
AI calibration process:
1. Collect labelled emergencies (min 200) across fire/medical/security/accident/other
2. Run Safety Fusion + optional modelAssist
3. Compute precision, recall, F1, FP/FN, Brier, ECE, abstention rate, latency p50/p95
4. Until then UI must say "Safety Fusion Confidence" not "probability"
5. Circuit breaker: after N provider failures, skip external model (platform continues)
`);
