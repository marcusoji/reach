import React, { useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { Button } from '../../components/common/Button';
import { Modal } from '../../components/common/Modal';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { getInstitutionBmoniBilling, prepareBmoniInstitutionPayment, submitBmoniInstitutionPaymentSignature, createInstitutionBmoniUser, createBmoniOwnerProofChallenge, createBmoniWallet, startBmoniNigeria, getBmoniDepositAccount } from '../../lib/reachApi';
import { CreditCard, ShieldCheck, WalletCards, RefreshCw, ArrowRight, CheckCircle2 } from 'lucide-react';

const money = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
};

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

  const currentInstitution = institutions[0];
  const refresh = async () => {
    setLoading(true);
    try { const result = await getInstitutionBmoniBilling(); setBilling(result.data); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Unable to load BMONI billing'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const account = billing?.account;
  const setupSteps = useMemo(() => [
    ['BMONI payer account', Boolean(account?.bmoni_user_id)],
    ['CNGN smart wallet', Boolean(account?.smart_wallet_id)],
    ['Nigeria onboarding', Boolean(account?.bvn_verified)],
    ['NGN virtual account', Boolean(account?.ngn_virtual_account_ready)],
  ] as const, [account]);

  if (!currentInstitution) return <div className="reach-card" style={{padding:'2rem'}}><h2>Institution data unavailable</h2><p style={{color:'var(--reach-text-secondary)',marginTop:8}}>Connect the REACH backend or finish institution setup to load live data.</p></div>;

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (error) { showToast(error instanceof Error ? error.message : 'BMONI operation failed'); } finally { setBusy(false); } };

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
            <Button variant="primary" onClick={() => setPayModalOpen(true)} disabled={loading || !billing?.configured || !billing?.treasury_address_configured}>
              <CreditCard size={16}/> Pay institution subscription
            </Button>
            <Button variant="ghost" onClick={() => setSetupModalOpen(true)}><WalletCards size={16}/> Configure BMONI</Button>
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16}/> Refresh</Button>
          </div>
          {!billing?.configured && <p style={{color:'var(--status-warning-text)',lineHeight:1.5}}>BMONI is not configured on the server yet. Add the BMONI server secret before enabling live institutional payments.</p>}
          {billing?.configured && !billing?.treasury_address_configured && <p style={{color:'var(--status-warning-text)',lineHeight:1.5}}>The REACH BMONI treasury wallet is not configured. Payments remain disabled until operations configures the destination.</p>}
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
          <input className="reach-input" placeholder="Authorized payer first name" value={payer.first_name} onChange={e=>setPayer({...payer,first_name:e.target.value})}/>
          <input className="reach-input" placeholder="Authorized payer last name" value={payer.last_name} onChange={e=>setPayer({...payer,last_name:e.target.value})}/>
          <input className="reach-input" placeholder="Authorized payer email" value={payer.email} onChange={e=>setPayer({...payer,email:e.target.value})}/>
          <input className="reach-input" placeholder="Phone number, E.164" value={payer.phone_number} onChange={e=>setPayer({...payer,phone_number:e.target.value})}/>
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
          {paymentSession && <div style={{padding:'1rem',background:'var(--reach-bg-card)',borderRadius:'var(--reach-radius-md)',lineHeight:1.55,display:'grid',gap:'.75rem'}}><strong>Secure signing required</strong><p style={{marginTop:0,color:'var(--reach-text-secondary)'}}>Proposal: {paymentSession.proposal_id}</p><p style={{marginTop:0,color:'var(--reach-text-secondary)',wordBreak:'break-word'}}>Hash: {paymentSession.sign_payload?.hashToSign || paymentSession.sign_payload?.payload || 'See returned signing payload'}</p><p style={{marginTop:0}}>Use the BMONI Embedded SDK on the authorized institution device and sign the raw 32-byte hash with <strong>signTransactionHash</strong>. Never use EIP-191 for this payment step.</p><input className="reach-input" placeholder="0x… 65-byte BMONI signature" value={paymentSignature} onChange={e=>setPaymentSignature(e.target.value)} /><Button variant="primary" disabled={busy || !paymentSignature} onClick={() => void run(async()=>{ const r=await submitBmoniInstitutionPaymentSignature(paymentSession.proposal_id, paymentSignature); setPaymentStatus(r.data); showToast('BMONI signature submitted; waiting for settlement confirmation'); })}>Submit secure signature</Button>{paymentStatus && <div><strong>Provider status</strong><p style={{marginTop:4,color:'var(--reach-text-secondary)'}}>{JSON.stringify(paymentStatus).slice(0,300)}</p></div>}</div>}
        </div>
      </Modal>
    </div>
  );
};
