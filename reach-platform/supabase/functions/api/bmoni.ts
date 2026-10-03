const BASE_URL = (Deno.env.get('BMONI_BASE_URL') || '').replace(/\/$/, '');
const API_KEY = Deno.env.get('BMONI_API_KEY') || '';

export function bmoniConfigured() {
  return Boolean(API_KEY && BASE_URL && /^https:\/\//i.test(BASE_URL));
}

function requireConfigured() {
  if (!bmoniConfigured()) throw new Error('BMONI is not configured on the server');
}

/** Pull the stable provider id out of a `POST /v1/users` (or `GET /v1/users/{id}`) body.
 *  BMONI wraps the record in a `user` object that carries **two** ids: the internal
 *  row `id` and the `bmoniUserId` that every user-scoped path actually accepts. They
 *  are different values, so an unwrap must read the nested `user.bmoniUserId` and must
 *  never fall back to the internal row id — using it 404s ("User not found") on every
 *  later call. Returns null when the shape is unrecognised so the caller can heal or
 *  fail loudly instead of storing a broken id. */
export function bmoniUserIdFrom(payload: any): string | null {
  const user = payload?.user ?? payload?.data?.user ?? payload?.data ?? payload;
  const id = user?.bmoniUserId ?? payload?.bmoniUserId;
  return id ? String(id) : null;
}

/** Find an already-created user's `bmoniUserId` by email, for healing an account that
 *  stored the wrong id. BMONI has no email filter, so this pages `GET /v1/users`
 *  (the shared sandbox key sees the whole partner tenant). Bounded to 10 pages of 100
 *  so a missing match fails fast rather than scanning the whole tenant. */
export async function findBmoniUserIdByEmail(email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const body = await request<any>(`/v1/users?page=${page}&limit=100`);
    const users: any[] = body?.users ?? [];
    if (!users.length) return null;
    const match = users.find((u) => String(u?.email || '').toLowerCase() === target);
    if (match) return bmoniUserIdFrom(match);
    if (users.length < 100) return null;
  }
  return null;
}

/** Normalise a phone number to the E.164 shape BMONI requires.
 *  A bare local number is assumed Nigerian (+234) — the sandbox and the NGN rail are
 *  Nigeria-only and REACH's onboarding path is `start-nigeria` — rather than guessed.
 *  Anything without a country code that is not a local Nigerian number is rejected,
 *  because BMONI answers a non-E.164 number with a bare `400 Validation failed`. */
export function normalizePhone(raw: unknown): string | null {
  const input = String(raw ?? '').trim();
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (!digits) return null;
  if (input.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('234') && digits.length === 13) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`;
  return null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  requireConfigured();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const headers = new Headers(init.headers || {});
  headers.set('x-api-key', API_KEY);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  try { response = await fetch(`${BASE_URL}${path}`, { ...init, headers, signal: controller.signal }); }
  catch (error) { throw new Error(error instanceof DOMException && error.name === 'AbortError' ? 'BMONI request timed out' : 'Unable to reach BMONI'); }
  finally { clearTimeout(timer); }
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!response.ok) {
    // BMONI validation failures return the detail as an array (`message: ["property x should not exist"]`),
    // not a string; stringify it so the cause survives to the caller instead of a bare "Validation failed".
    const rawMessage = body?.message ?? body?.error;
    const providerMessage = Array.isArray(rawMessage) ? rawMessage.join('; ').slice(0, 240)
      : (typeof rawMessage === 'string' ? rawMessage.slice(0, 240) : '');
    const message = `BMONI request failed (${response.status})${providerMessage ? `: ${providerMessage}` : ''}`;
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).body = body;
    throw error;
  }
  return body as T;
}

export const bmoni = {
  createUser: (body: { firstName: string; lastName: string; email: string; phoneNumber: string }) =>
    request<any>('/v1/users', { method: 'POST', body: JSON.stringify(body) }),
  updateKyc: (userId: string, body: unknown) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/kyc`, { method: 'PATCH', body: JSON.stringify(body) }),
  ownerProofChallenge: (userId: string, body: { currency: 'CNGN'; userOwnerAddress: string }) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/smart-wallets/owner-proof-challenges`, { method: 'POST', body: JSON.stringify(body) }),
  createManagedWallet: (userId: string, body: { currency: 'CNGN'; userOwnerAddress: string; ownerProofChallengeId: string; ownerProofSignature: string }) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/smart-wallets/create-managed`, { method: 'POST', body: JSON.stringify(body) }),
  startNigeria: (userId: string, body: { bvn: string; ngnWalletAddress: string; ngnWalletIndex: number }) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/onboarding/start-nigeria`, { method: 'POST', body: JSON.stringify(body) }),
  onboardingStatus: (userId: string) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/onboarding/status`),
  depositAccount: (userId: string) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/bank-accounts/deposit-accounts/NGN`),
  banks: (userId: string) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/bank-accounts/nigerian-banks`),
  verifyBank: (userId: string, body: { accountNumber: string; bankCode: string }) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/bank-accounts/verify-nigerian-account`, { method: 'POST', body: JSON.stringify(body) }),
  registerWithdrawalAccount: (userId: string, body: { accountNumber: string; bankCode: string; bankName: string; accountHolderName: string }) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/bank-accounts/withdrawal-accounts/nigeria`, { method: 'POST', body: JSON.stringify(body) }),
  createOfframp: (userId: string, walletId: string, body: { bankAccountId: string; fromAmount: string }) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/smart-wallets/${encodeURIComponent(walletId)}/offramp/nigeria`, { method: 'POST', body: JSON.stringify(body) }),
  createProposal: (userId: string, walletId: string, body: unknown) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/smart-wallets/${encodeURIComponent(walletId)}/proposals`, { method: 'POST', body: JSON.stringify(body) }),
  approveProposal: (userId: string, proposalId: string) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/smart-wallets/proposals/${encodeURIComponent(proposalId)}/approve`, { method: 'POST' }),
  proposalSignPayload: (userId: string, proposalId: string) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/smart-wallets/proposals/${encodeURIComponent(proposalId)}/sign-payload`),
  signProposal: (userId: string, proposalId: string, signature: string) =>
    request<any>(`/v1/users/${encodeURIComponent(userId)}/smart-wallets/proposals/${encodeURIComponent(proposalId)}/sign`, { method: 'POST', body: JSON.stringify({ signature }) }),
  configureWebhooks: (body: unknown) =>
    request<any>('/v1/webhooks/config', { method: 'POST', body: JSON.stringify(body) }),
};
