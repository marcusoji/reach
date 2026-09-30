const BASE_URL = (Deno.env.get('BMONI_BASE_URL') || '').replace(/\/$/, '');
const API_KEY = Deno.env.get('BMONI_API_KEY') || '';

export function bmoniConfigured() {
  return Boolean(API_KEY && BASE_URL && /^https:\/\//i.test(BASE_URL));
}

function requireConfigured() {
  if (!bmoniConfigured()) throw new Error('BMONI is not configured on the server');
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
    const providerMessage = typeof body?.message === 'string' ? body.message.slice(0, 240) : '';
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
