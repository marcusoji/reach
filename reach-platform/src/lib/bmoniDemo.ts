/**
 * Sandbox demo configuration for the BMONI Configure flow.
 *
 * REACH talks to the real BMONI sandbox for the steps that the sandbox actually performs
 * (payer, wallet, onboarding, deposit account, proposal). Two steps can never be automated
 * from the web app — the owner-proof signature and the payment signature both require the
 * wallet owner's private key, which by design never leaves the institution's BMONI device —
 * and settlement additionally needs a funded wallet plus a webhook re-registered to REACH.
 * Those steps are labelled as simulated so the demo never claims a settlement that did not
 * happen.
 *
 * The persona below is the one documented as working on the sandbox
 * (docs/BMONI_INTEGRATION_NOTES.md §3). The phone number must be unique per payer, so it is
 * generated fresh from the timestamp rather than hardcoded — a duplicate returns `409`.
 */

export type BmoniDemoPayer = { first_name: string; last_name: string; email: string; phone_number: string };

/** The documented working sandbox persona. BVN is Bunch Dillon's (`95888168924`). */
export const BMONI_DEMO_PERSONA = { first_name: 'Bunch', last_name: 'Dillon', bvn: '95888168924' } as const;

/**
 * A fresh, unique E.164 Nigerian sandbox phone. BMONI rejects a duplicate number with `409`,
 * so the demo must not reuse a fixed one; the last 8 digits are derived from the clock and a
 * random suffix so two runs in the same millisecond still differ.
 */
export function bmoniDemoPhone(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = String(Math.floor(now / 1000) % 100_000_000).padStart(8, '0');
  const digit = Math.floor(random() * 10) % 10;
  return `+2349${digit}${tail}`;
}

/** Build the payer the demo creates: the documented persona with a fresh email and phone. */
export function bmoniDemoPayer(emailDomain = 'reach.dev', now: number = Date.now(), random: () => number = Math.random): BmoniDemoPayer {
  const stamp = String(now).slice(-8);
  return {
    first_name: BMONI_DEMO_PERSONA.first_name,
    last_name: BMONI_DEMO_PERSONA.last_name,
    email: `bmoni.demo.${stamp}@${emailDomain}`,
    phone_number: bmoniDemoPhone(now, random),
  };
}

export type BmoniDemoStepStatus = 'live' | 'simulated' | 'skipped';

export type BmoniDemoStep = {
  key: string;
  label: string;
  /** `live` calls the real sandbox; `simulated` is labelled and never claimed as provider work. */
  status: BmoniDemoStepStatus;
  detail: string;
};

/**
 * The demo step plan. Each `live` step maps to a real REACH API call; each `simulated` step
 * is a UI-only placeholder. `skipSteps` lets the UI mark steps already done for this
 * institution (a payer/wallet that already exists) as `skipped` instead of re-running them.
 */
export function bmoniDemoPlan(skipSteps: string[] = []): BmoniDemoStep[] {
  const skip = new Set(skipSteps);
  const plan: BmoniDemoStep[] = [
    { key: 'payer', label: 'Create BMONI payer', status: 'live', detail: 'POST /v1/users on the sandbox with the documented persona and a fresh phone.' },
    { key: 'challenge', label: 'Owner-proof challenge', status: 'live', detail: 'POST .../owner-proof-challenges on the sandbox.' },
    { key: 'wallet', label: 'Sign owner proof + create wallet', status: 'simulated', detail: 'Requires the wallet owner key (BMONI device). Simulated for the MVP; the sandbox call is live once a signature is supplied.' },
    { key: 'onboarding', label: 'Nigeria onboarding (BVN)', status: 'live', detail: 'POST .../onboarding/start-nigeria on the sandbox.' },
    { key: 'deposit', label: 'NGN virtual account', status: 'live', detail: 'GET .../bank-accounts/deposit-accounts/NGN on the sandbox.' },
    { key: 'proposal', label: 'Subscription proposal', status: 'live', detail: 'POST .../proposals + approve + sign-payload on the sandbox.' },
    { key: 'sign', label: 'Sign + settle subscription', status: 'simulated', detail: 'Requires the owner key and a funded wallet with a webhook pointed at REACH. Simulated for the MVP.' },
  ];
  return plan.map((step) => (skip.has(step.key) ? { ...step, status: 'skipped' as const } : step));
}

/** True when a plan contains at least one step that hits the real sandbox. */
export function bmoniDemoHasLiveSteps(plan: BmoniDemoStep[]): boolean {
  return plan.some((step) => step.status === 'live');
}
