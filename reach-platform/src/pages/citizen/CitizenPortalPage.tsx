import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export const CitizenPortalPage: React.FC = () => {
  const { user } = useAuth();
  return <main style={{ maxWidth: 720, margin: '0 auto', padding: 32 }}>
    <h1>REACH Citizen</h1>
    <p>Welcome, {user?.name}. Use the REACH mobile experience for emergency reporting, offline relay and incident tracking.</p>
    <div style={{ display:'grid', gap:12, marginTop:24 }}>
      <div className="card"><strong>Identity</strong><p>{user?.email}</p></div>
      <div className="card"><strong>Safety network</strong><p>Your citizen account uses the same REACH incident, notification and relay backend as responders and institutions.</p></div>
      <Link to="/login">Return to account</Link>
    </div>
  </main>;
};
