import React, { useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { Button } from '../../components/common/Button';
import { Modal } from '../../components/common/Modal';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { getInstitutionBmoniBilling, prepareBmoniInstitutionPayment, submitBmoniInstitutionPaymentSignature, createInstitutionBmoniUser, createBmoniOwnerProofChallenge, createBmoniWallet, startBmoniNigeria, getBmoniDepositAccount, getBmoniOnboardingStatus } from '../../lib/reachApi';
import { BMONI_DEMO_PERSONA, bmoniDemoPayer } from '../../lib/bmoniDemo';
import { CreditCard, ShieldCheck, WalletCards, RefreshCw, ArrowRight, CheckCircle2, PlayCircle } from 'lucide-react';

const money = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'BMONI operation failed');

export const BillingPlanPage: React.FC = () => {
  const { institutions, paymentHistory } = useApp();
  const { user, showToast } = useAuth();
  const [billing, setBilling] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payer, setPayer] = useState({ first_name: '', last_name: '', email: user?.email || '', phone_number: '' });
  const [walletAddress, setWalletAddress] = useState('');
  const [challenge, setChallenge] = useState<any>(null);
  const [ownerSignature, setOwnerSignature] = useState('');
  const [bvn, setBvn] = useState('');
  const [paymentSession, setPaymentSession] = useState<any>(null);
  const [paymentSignature, setPaymentSignature] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<any>(null);
  const [demoPlan, setDemoPlan] = useState<any[]>([]);
  const [demoRunning, setDemoRunning] = useState(false);

  const currentInstitution = institutions[0];
  const refresh = async () => {
    setLoading(true);
    try { const result = await getInstitutionBmoniBilling(); setBilling(result.data); }
    catch (error) { showToast(errorText(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  /** Prefill the configure form with the documented sandbox persona and a fresh phone. */
  const prefillSandboxPersona = () => {
    const fresh = bmoniDemoPayer('reach.dev');
    setPayer({ first_name: fresh.first_name, last_name: fresh.last_name, email: fresh.email, phone_number: fresh.phone_number });
    setBvn(BMONI_DEMO_PERSONA.bvn);
    showToast('Sandbox persona loaded: Bunch Dillon + a fresh phone number');
  };

  const account = billing?.account;
  const setupSteps = useMemo(() => [
    ['BMONI payer account', Boolean(account?.bmoni_user_id)],
    ['CNGN smart wallet', Boolean(account?.smart_wallet_id)],
    ['Nigeria onboarding', Boolean(account?.bvn_verified)],
    ['NGN virtual account', Boolean(account?.ngn_virtual_account_ready)],
  ] as const, [account]);

  if (!currentInstitution) return <div className="reach-card" style={{padding:'2rem'}}><h2>Institution data unavailable</h2><p style={{color:'var(--reach-text-secondary)',marginTop:8}}>Connect the REACH backend or finish institution setup to load live data.</p></div>;

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (error) { showToast(errorText(error)); } finally { setBusy(false); } };

  /**
   * One-click sandbox demo. Drives the real BMONI sandbox for the steps it can perform
   * (payer, owner-proof challenge, onboarding, deposit account, proposal) and labels the two
   * steps that structurally cannot be automated from the web app — the owner-proof signature
   * and the payment signature/settlement — as simulated. Nothing is claimed as settled unless
   * the provider actually returned it.
   */
  const runSandboxDemo = async () => {
    setDemoRunning(true);
    const steps: any[] = [];
    const add = (key: string, label: string, status: string, detail: string) => {
      steps.push({ key, label, status, detail });
      setDemoPlan([...steps]);
    };
    const hasPayer = Boolean(account?.bmoni_user_id);
    const hasWallet = Boolean(account?.smart_wallet_id);
    const onboarded = account?.onboarding_status === 'active' || Boolean(account?.ngn_virtual_account_ready);
    const pendingPayment = (billing?.payments || []).find((p: any) => p.status === 'pending');
    try {
      // 1. Payer — real sandbox call, or reuse the payer already linked to this institution.
      if (hasPayer) {
        add('payer', 'Create BMONI payer', 'skipped', `Reusing sandbox payer ${account.bmoni_user_id}.`);
      } else {
        const fresh = bmoniDemoPayer('reach.dev');
        setPayer({ first_name: fresh.first_name, last_name: fresh.last_name, email: fresh.email, phone_number: fresh.phone_number });
        const result = await createInstitutionBmoniUser(fresh);
        add('payer', 'Create BMONI payer', 'live', `Sandbox user ${result?.data?.bmoni_user_id ?? 'created'} (persona Bunch Dillon).`);
      }
      // 2. Owner-proof challenge — real sandbox call when the wallet does not exist yet.
      if (!hasWallet) {
        const result = await createBmoniOwnerProofChallenge(`0x${'0'.repeat(40)}`);
        add('challenge', 'Owner-proof challenge', 'live', `Challenge ${result?.data?.challengeId ?? 'issued'} returned by the sandbox.`);
      } else {
        add('challenge', 'Owner-proof challenge', 'skipped', 'Wallet already provisioned for this institution.');
      }
      // 3. Owner-proof signature + wallet creation — requires the owner key (BMONI device).
      add('wallet', 'Sign owner proof + create wallet', hasWallet ? 'skipped' : 'simulated', hasWallet
        ? 'Smart wallet already exists; the sandbox wallet is real.'
        : 'Needs the wallet owner key on the institution BMONI device; simulated for the MVP.');
      // 4. Nigeria onboarding — real sandbox call when a wallet exists and onboarding has not run.
      if (hasWallet && !onboarded) {
        await startBmoniNigeria(BMONI_DEMO_PERSONA.bvn);
        add('onboarding', 'Nigeria onboarding (BVN)', 'live', `start-nigeria called with BVN ${BMONI_DEMO_PERSONA.bvn}.`);
      } else {
        add('onboarding', 'Nigeria onboarding (BVN)', hasWallet ? 'skipped' : 'simulated', hasWallet
          ? 'Already active for this institution.'
          : 'Runs after the wallet exists; simulated for the MVP.');
      }
      // 5. NGN virtual account — real read-only sandbox call when a wallet exists.
      if (hasWallet) {
        const status = await getBmoniOnboardingStatus();
        const deposit = await getBmoniDepositAccount();
        const accountNumber = deposit?.data?.accounts?.find((a: any) => a.currency === 'NGN')?.accountNumber;
        add('deposit', 'NGN virtual account', 'live', `anchorStatus: ${status?.data?.anchorStatus ?? 'unknown'}${accountNumber ? `; NGN account ${accountNumber}` : ''}.`);
      } else {
        add('deposit', 'NGN virtual account', 'simulated', 'Runs after onboarding; simulated for the MVP.');
      }
      // 6. Subscription proposal — real sandbox call, unless one is already pending.
      if (pendingPayment) {
        add('proposal', 'Subscription proposal', 'skipped', `A proposal is already pending (${pendingPayment.provider_reference ?? pendingPayment.id}); not creating a second one.`);
      } else if (hasWallet) {
        const result = await prepareBmoniInstitutionPayment();
        setPaymentSession(result.data);
        add('proposal', 'Subscription proposal', 'live', `Proposal ${result?.data?.proposal_id ?? 'created'} approved; sign payload ready.`);
      } else {
        add('proposal', 'Subscription proposal', 'simulated', 'Runs after the wallet exists; simulated for the MVP.');
      }
      // 7. Signature + settlement — requires the owner key and a funded wallet + REACH webhook.
      add('sign', 'Sign + settle subscription', 'simulated', 'Needs the owner key and a funded sandbox wallet with the webhook pointed at REACH; simulated for the MVP.');
      showToast('Sandbox demo finished — live steps hit the real sandbox; simulated steps are labelled.');
      await refresh();
    } catch (error) {
      add('error', 'Demo stopped', 'simulated', errorText(error));
      showToast(errorText(error));
    } finally {
      setDemoRunning(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow={`Institution · ${currentInstitution.name}`}
        tag={currentInstitution.code}
        title="Billing and Plan"
        subtitle="The institution is the only REACH account that pays. Residents, staff, security personnel and responders use REACH without individual emergency-access charges."
      />

      <div className="desktop-two-col">
        <div className="reach-card" style={{ padding: '1.5rem', gap: '1.5rem' }}>
          <div style={{display:'flex',justifyContent:'space-between',gap:'1rem',alignItems:'flex-start'}}>
            <div>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 800 }}>REACH Institutional Subscription</h2>
              <p style={{color:'var(--reach-text-secondary)',marginTop:6,lineHeight:1.5}}>One institutional plan covers the people and emergency-response services configured for this site.</p>
            </div>
            <span className="reach-badge"><ShieldCheck size={14}/> Institution only</span>
          </div>
          <div className="key-value-list" style={{ padding: 0 }}>
            <KeyValueRow label="Subscription" value={<span style={{fontWeight:700}}>{billing?.subscription?.status || currentInstitution.status}</span>} />
            <KeyValueRow label="Plan" value={billing?.subscription?.plan_name || 'REACH Full'} />
            <KeyValueRow label="Payment rail" value="BMONI Embedded · CNGN" />
            <KeyValueRow label="Next charge" value={billing?.subscription?.current_period_end || '—'} />
            <KeyValueRow label="Individual emergency access" value="No individual payment" />
          </div>
          <div style={{display:'flex',gap:'.75rem',flexWrap:'wrap'}}>
            <Button variant="primary" onClick={() => setPayModalOpen(true)} disabled={loading || !billing?.configured || !account?.smart_wallet_id}>
              <CreditCard size={16}/> Pay institution subscription
            </Button>
            <Button variant="ghost" onClick={() => { if (!payer.email && !payer.phone_number) prefillSandboxPersona(); setSetupModalOpen(true); }}><WalletCards size={16}/> Configure BMONI</Button>
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16}/> Refresh</Button>
          </div>
          {!billing?.configured && <p style={{color:'var(--status-warning-text)',lineHeight:1.5}}>BMONI is not configured on the server yet. Add the BMONI server secret before enabling live institutional payments.</p>}
          {billing?.configured && !account?.smart_wallet_id && <p style={{color:'var(--status-warning-text)',lineHeight:1.5}}>Complete BMONI setup below (payer, wallet, onboarding) before paying. The subscription transfer is sent to the REACH treasury wallet, which is configured on the server.</p>}
        </div>

        <div className="reach-card" style={{ padding: '1.5rem', gap: '1.25rem' }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800 }}>BMONI Setup</h2>
          <div style={{display:'grid',gap:'.75rem'}}>
            {setupSteps.map(([label, done]) => <div key={label} style={{display:'flex',alignItems:'center',gap:'.7rem'}}>{done ? <CheckCircle2 size={18} /> : <span style={{width:18,height:18,border:'2px solid var(--reach-border)',borderRadius:'50%'}}/>}<span>{label}</span></div>)}
          </div>
          <div style={{background:'var(--reach-bg-card)',borderRadius:'var(--reach-radius-md)',padding:'1rem',lineHeight:1.55}}>
            <strong>Who pays?</strong>
            <p style={{marginTop:5,color:'var(--reach-text-secondary)'}}>Only the institution. REACH does not charge individual residents, students, staff, security personnel, responders or operators for emergency access.</p>
          </div>
        </div>
      </div>

      <div className="reach-card" style={{padding:'1.5rem'}}>
        <h2 style={{fontSize:'1.2rem',fontWeight:800,marginBottom:'1rem'}}>Payment History</h2>
        {paymentHistory.length === 0 ? <p style={{color:'var(--reach-text-secondary)'}}>No institutional payments recorded yet.</p> : <div className="key-value-list" style={{padding:0}}>{paymentHistory.map(item => <KeyValueRow key={item.id} label={`${item.date} · ${item.code}`} value={<span style={{fontWeight:700}}>{item.status}{item.amount ? ` · ${item.amount}` : ''}</span>} />)}</div>}
      </div>

      <Modal isOpen={setupModalOpen} onClose={() => setSetupModalOpen(false)} title="Configure BMONI for this institution">
        <div style={{display:'flex',flexDirection:'column',gap:'1rem'}}>
          <p style={{color:'var(--reach-text-secondary)',lineHeight:1.5}}>BMONI's secure signing SDK belongs on the institution's supported mobile device. This web dashboard never receives the private key.</p>
          <div style={{display:'flex',gap:'.75rem',flexWrap:'wrap'}}>
            <Button variant="primary" disabled={demoRunning} onClick={() => void runSandboxDemo()}><PlayCircle size={16}/> Run sandbox demo</Button>
            <Button variant="ghost" disabled={demoRunning} onClick={prefillSandboxPersona}>Load sandbox details</Button>
          </div>
          <p style={{color:'var(--reach-text-secondary)',lineHeight:1.5,fontSize:'13px'}}>The demo drives the real BMONI sandbox for payer, challenge, onboarding, deposit account and proposal. The two signature steps (owner proof, payment) need the wallet owner's key on the BMONI device, so they are labelled <strong>simulated</strong> — the demo never claims a settlement the sandbox did not make.</p>
          {demoPlan.length > 0 && <div style={{display:'grid',gap:'.5rem',padding:'1rem',background:'var(--reach-bg-card)',borderRadius:'var(--reach-radius-md)'}}>
            {demoPlan.map((step) => <div key={step.key} style={{display:'flex',gap:'.6rem',alignItems:'flex-start'}}>
              <span style={{fontWeight:800,fontSize:'12px',textTransform:'uppercase',minWidth:'76px',color:step.status==='live'?'var(--status-success-text)':step.status==='skipped'?'var(--reach-text-secondary)':'var(--status-warning-text)'}}>{step.status}</span>
              <span style={{lineHeight:1.45}}><strong>{step.label}</strong><br/><span style={{color:'var(--reach-text-secondary)',fontSize:'13px'}}>{step.detail}</span></span>
            </div>)}
          </div>}
          <input className="reach-input" placeholder="Authorized payer first name" value={payer.first_name} onChange={e=>setPayer({...payer,first_name:e.target.value})}/>
          <input className="reach-input" placeholder="Authorized payer last name" value={payer.last_name} onChange={e=>setPayer({...payer,last_name:e.target.value})}/>
          <input className="reach-input" placeholder="Authorized payer email" value={payer.email} onChange={e=>setPayer({...payer,email:e.target.value})}/>
          <input className="reach-input" placeholder="Phone number, e.g. +2348012345678" value={payer.phone_number} onChange={e=>setPayer({...payer,phone_number:e.target.value})}/>
          <Button variant="primary" disabled={busy} onClick={() => void run(async()=>{ await createInstitutionBmoniUser(payer); showToast('BMONI payer account created'); await refresh(); })}>1 · Create BMONI payer</Button>
          <input className="reach-input" placeholder="CNGN wallet address (from BMONI mobile SDK)" value={walletAddress} onChange={e=>setWalletAddress(e.target.value)}/>
          <Button variant="ghost" disabled={busy || !walletAddress} onClick={() => void run(async()=>{ const r=await createBmoniOwnerProofChallenge(walletAddress); setChallenge(r.data); showToast('Owner-proof challenge created'); })}>2 · Create owner-proof challenge</Button>
          {challenge && <div style={{padding:'1rem',background:'var(--reach-bg-card)',borderRadius:'var(--reach-radius-md)',lineHeight:1.5}}><strong>Sign this challenge on the BMONI-enabled institution device.</strong><p style={{marginTop:6,wordBreak:'break-word',color:'var(--reach-text-secondary)'}}>{challenge.message || challenge.challenge || challenge.data?.message}</p></div>}
          <input className="reach-input" placeholder="EIP-191 owner-proof signature" value={ownerSignature} onChange={e=>setOwnerSignature(e.target.value)}/>
          <Button variant="ghost" disabled={busy || !challenge || !ownerSignature} onClick={() => void run(async()=>{ await createBmoniWallet({wallet_address:walletAddress,owner_proof_challenge_id:String(challenge.id || challenge.challengeId || challenge.data?.id),owner_proof_signature:ownerSignature}); showToast('CNGN smart wallet created'); await refresh(); })}>3 · Create managed wallet</Button>
          <input className="reach-input" placeholder="11-digit BVN" inputMode="numeric" maxLength={11} value={bvn} onChange={e=>setBvn(e.target.value.replace(/\D/g,''))}/>
          <Button variant="ghost" disabled={busy || bvn.length !== 11 || !account?.smart_wallet_id} onClick={() => void run(async()=>{ await startBmoniNigeria(bvn); showToast('Nigeria onboarding started'); await refresh(); })}>4 · Start Nigeria onboarding</Button>
          <Button variant="ghost" disabled={busy || !account?.bmoni_user_id} onClick={() => void run(async()=>{ const r=await getBmoniDepositAccount(); showToast(`NGN virtual account loaded: ${JSON.stringify(r.data).slice(0,120)}…`); await refresh(); })}>5 · Load NGN virtual account</Button>
        </div>
      </Modal>

      <Modal isOpen={payModalOpen} onClose={() => setPayModalOpen(false)} title="Institutional BMONI payment" footer={<Button variant="ghost" onClick={()=>setPayModalOpen(false)}>Close</Button>}>
        <div style={{display:'flex',flexDirection:'column',gap:'1rem'}}>
          <div style={{display:'flex',gap:'.75rem',alignItems:'center'}}><WalletCards size={22}/><div><strong>BMONI Embedded · CNGN</strong><p style={{color:'var(--reach-text-secondary)',marginTop:4}}>Only this institution is charged.</p></div></div>
          <KeyValueRow label="Amount" value={money(billing?.configured_amount_cngn)} />
          <KeyValueRow label="Subscription" value={billing?.subscription?.plan_name || 'REACH Full'} />
          <p style={{color:'var(--reach-text-secondary)',lineHeight:1.5}}>REACH creates and approves the BMONI proposal server-side. The final raw transaction hash must be signed on the institution's BMONI-enabled device using <strong>signTransactionHash</strong>. The web app never handles the private key.</p>
          <Button variant="primary" disabled={busy || !account?.smart_wallet_id || !billing?.configured_amount_cngn} onClick={() => void run(async()=>{ const r=await prepareBmoniInstitutionPayment(); setPaymentSession(r.data); showToast('BMONI payment proposal prepared for secure signing'); })}><ArrowRight size={16}/> Prepare BMONI payment</Button>
          {paymentSession && <div style={{padding:'1rem',background:'var(--reach-bg-card)',borderRadius:'var(--reach-radius-md)',lineHeight:1.55,display:'grid',gap:'.75rem'}}><strong>Secure signing required</strong><p style={{marginTop:0,color:'var(--reach-text-secondary)'}}>Proposal: {paymentSession.proposal_id}</p><p style={{marginTop:0,color:'var(--reach-text-secondary)',wordBreak:'break-word'}}>Hash: {paymentSession.sign_payload?.signingPayloadHash || paymentSession.sign_payload?.hashToSign || paymentSession.sign_payload?.payload || 'See returned signing payload'}</p><p style={{marginTop:0}}>Use the BMONI Embedded SDK on the authorized institution device and sign the raw 32-byte hash with <strong>signTransactionHash</strong>. Never use EIP-191 for this payment step.</p><input className="reach-input" placeholder="0x… 65-byte BMONI signature" value={paymentSignature} onChange={e=>setPaymentSignature(e.target.value)} /><Button variant="primary" disabled={busy || !paymentSignature} onClick={() => void run(async()=>{ const r=await submitBmoniInstitutionPaymentSignature(paymentSession.proposal_id, paymentSignature); setPaymentStatus(r.data); showToast('BMONI signature submitted; the subscription activates when BMONI confirms settlement'); await refresh(); })}>Submit secure signature</Button>{paymentStatus && <div><strong>Provider status</strong><p style={{marginTop:4,color:'var(--reach-text-secondary)'}}>{JSON.stringify(paymentStatus).slice(0,300)}</p></div>}</div>}
        </div>
      </Modal>
    </div>
  );
};
