// Shared UI constants

export const PHASE_LABELS = ['Concept', 'Architecture', 'Build', 'Docs', 'Infra'];

// §6.4 — Conductor commentary quips (client-side idle timer)
export const CONDUCTOR_QUIPS: Record<string, string[]> = {
  pm: [
    "Still structuring your idea. Patience is a virtue you clearly lack.",
    "The PM is overthinking this. As always.",
  ],
  architect: [
    "The architect is designing something beautiful. You wouldn't understand.",
    "Schema decisions are being made. Try not to interfere.",
  ],
  engineer: [
    "Code is being written. One would hope it compiles.",
    "The engineer is in the zone. Or possibly stuck. Hard to tell.",
    "Making progress. Slowly. But progress nonetheless.",
  ],
  qa: [
    "Tests are being written. Somewhere, a bug trembles in fear.",
    "QA is finding things you missed. As usual.",
  ],
  security: [
    "Scanning for vulnerabilities. There are always vulnerabilities.",
    "The security agent is judging your design choices. Harshly.",
  ],
  validator: [
    "Validation in progress. The suspense is killing me. Not really.",
    "Your code is being scrutinized. I'd be nervous if I were you.",
  ],
  docs: [
    "Documentation is being written. Someone has to.",
    "Technical writing in progress. Try to contain your excitement.",
  ],
  devops: [
    "Containerizing everything. Because that's what we do now.",
    "Infrastructure is being configured. It's more exciting than it sounds.",
  ],
  wrecker: [
    "The wrecker is looking for things to break. It won't take long.",
    "Adversarial testing in progress. Your code's worst nightmare.",
  ],
  default: [
    "Still processing. Science requires patience.",
    "Working on it. These things take time, you know.",
    "The enrichment center reminds you that good results require patience.",
  ],
};
