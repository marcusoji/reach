import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { joinInstitutionWithCode } from '../../lib/reachApi';

export const CitizenPortalPage: React.FC = () => {
  const { user, showToast } = useAuth();
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const join = async () => {
    if (!code.trim()) { setStatus('Enter the code your estate office gave you.'); return; }
    setBusy(true); setStatus('Joining…');
    try {
      await joinInstitutionWithCode(code.trim());
      setCode('');
      setStatus('Joined. Your reports will now reach this estate.');
      showToast?.('Estate joined');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'That join code was not accepted.');
    } finally { setBusy(false); }
  };

  return <main style={{ maxWidth: 720, margin: '0 auto', padding: 32 }}>
    <h1>REACH Citizen</h1>
    <p>Welcome, {user?.name}. Use the REACH mobile experience for emergency reporting, offline relay and incident tracking.</p>
    <div style={{ display:'grid', gap:12, marginTop:24 }}>
      <div className="card"><strong>Identity</strong><p>{user?.email}</p></div>
      <div className="card"><strong>Safety network</strong><p>Your citizen account uses the same REACH incident, notification and relay backend as responders and institutions.</p></div>
      <div className="card">
        <strong>Join your estate</strong>
        <p>Have a join code from your estate or community office? Enter it so your reports are routed to their response desk.</p>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <input value={code} onChange={e => setCode(e.target.value)} placeholder="REACH-XXXXXXXXXX" />
          <button className="reach-button reach-button--primary" disabled={busy} onClick={() => void join()}>Join</button>
        </div>
        {status && <p style={{ color:'var(--reach-text-secondary)' }}>{status}</p>}
      </div>
      <Link to="/login">Return to account</Link>
    </div>
  </main>;
};
