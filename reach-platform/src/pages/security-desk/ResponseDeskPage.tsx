import React,{useEffect,useState} from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { Badge } from '../../components/common/Badge';
import { Button } from '../../components/common/Button';
import { MediaChips } from '../../components/incidents/MediaChips';
import { Modal } from '../../components/common/Modal';
import { useApp } from '../../context/AppContext';
import { assignIncident,listResponders,isBackendConfigured } from '../../lib/reachApi';
import { Phone, CheckCircle, ShieldAlert, ArrowRight } from 'lucide-react';

export const ResponseDeskPage:React.FC=()=>{
 const {incidents,updateIncidentStatus,refreshIncidents}=useApp(); const activeIncident=incidents.find(i=>!['Resolved','Closed'].includes(i.status))||incidents[0];
 const [responders,setResponders]=useState<any[]>([]); const [assignOpen,setAssignOpen]=useState(false); const [selectedResponder,setSelectedResponder]=useState(''); const [callOpen,setCallOpen]=useState(false); const [feedback,setFeedback]=useState<string|null>(null);
 useEffect(()=>{if(isBackendConfigured)void listResponders().then(r=>setResponders(r.data||[])).catch(()=>undefined);},[]);
 if(!activeIncident) return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}><SectionHeader eyebrow="Security Desk" title="Response Desk" subtitle="No active incident is currently in the queue."/><div className="reach-card" style={{padding:'2rem'}}><p>No live incident is available.</p></div></div>;
 const act=(status:any,msg:string)=>{updateIncidentStatus(activeIncident.id,status);setFeedback(msg);window.setTimeout(()=>setFeedback(null),3500);};
 const assign=async()=>{if(!selectedResponder)return;try{if(isBackendConfigured)await assignIncident(activeIncident.id,selectedResponder);else act('Assigned',`Incident ${activeIncident.code} assigned.`);setAssignOpen(false);setFeedback(`Incident ${activeIncident.code} assigned to a responder.`);await refreshIncidents();}catch(e){setFeedback(e instanceof Error?e.message:'Assignment failed');}};
 const status=activeIncident.status;
 return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}>
  <SectionHeader eyebrow="Security Desk" title="Response Desk" subtitle="Review evidence, verify the incident, assign a responder, and advance the controlled response lifecycle."/>
  {feedback&&<div style={{background:'var(--status-success-bg)',color:'var(--status-success-text)',padding:'1rem 1.25rem',borderRadius:'var(--reach-radius-md)',fontWeight:700,display:'flex',alignItems:'center',gap:'.75rem'}}><CheckCircle size={20}/><span>{feedback}</span></div>}
  <div className="reach-card" style={{gap:'1.75rem'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:'1rem'}}><div style={{display:'flex',flexDirection:'column',gap:'.75rem'}}><p style={{color:'var(--reach-text-secondary)',fontWeight:600}}>{activeIncident.code}</p><h2 style={{fontSize:'2rem',fontWeight:900}}>{activeIncident.type}</h2><p style={{fontFamily:'monospace',color:'var(--reach-text-secondary)',fontSize:'.95rem'}}>{activeIncident.status.toUpperCase()} · {activeIncident.aiDetails.channel} · conf {activeIncident.aiDetails.confidence || '—'} · {activeIncident.aiDetails.fpCode}</p><MediaChips evidence={activeIncident.evidence} locationLabel={activeIncident.location}/></div><Badge variant={status==='Verifying'?'verifying':status==='Responding'?'responding':status==='On Scene'?'success':status==='Resolved'?'resolved':'active'}>{status}</Badge></div>
   <div style={{display:'flex',flexWrap:'wrap',gap:'1rem',paddingTop:'1rem',borderTop:'1px solid var(--reach-border-card)'}}>
    {['Reported','Received'].includes(status)&&<Button variant="dark" onClick={()=>act('Verifying',`Incident ${activeIncident.code} moved to verification.`)}><ShieldAlert size={16}/> Verify</Button>}
    {status==='Verifying'&&<Button variant="dark" onClick={()=>act('Verified',`Incident ${activeIncident.code} verified.`)}><CheckCircle size={16}/> Mark verified</Button>}
    {status==='Verified'&&<Button variant="dark" onClick={()=>setAssignOpen(true)}><ShieldAlert size={16}/> Assign responder</Button>}
    {status==='Assigned'&&<Button variant="dark" onClick={()=>act('Responding',`Responder is responding to ${activeIncident.code}.`)}><ArrowRight size={16}/> Start response</Button>}
    {status==='Responding'&&<Button variant="dark" onClick={()=>act('On Scene',`Responder is on scene for ${activeIncident.code}.`)}><ArrowRight size={16}/> On scene</Button>}
    {status==='On Scene'&&<Button variant="dark" onClick={()=>act('Resolved',`Incident ${activeIncident.code} resolved.`)}><CheckCircle size={16}/> Resolve</Button>}
    {status==='Resolved'&&<Button variant="dark" onClick={()=>act('Closed',`Incident ${activeIncident.code} closed.`)}>Close</Button>}
    {!['Resolved','Closed'].includes(status)&&<Button variant="ghost" onClick={()=>setCallOpen(true)}><Phone size={16}/> Contact reporter</Button>}
   </div>
  </div>
  <Modal isOpen={assignOpen} onClose={()=>setAssignOpen(false)} title="Assign responder" footer={<><Button variant="ghost" onClick={()=>setAssignOpen(false)}>Cancel</Button><Button variant="primary" disabled={!selectedResponder} onClick={()=>void assign()}>Assign</Button></>}><div style={{display:'flex',flexDirection:'column',gap:'1rem'}}><p>Select an available responder from this institution.</p><select value={selectedResponder} onChange={e=>setSelectedResponder(e.target.value)}><option value="">Select responder</option>{responders.map(r=><option key={r.id} value={r.id}>{r.profiles?.full_name||r.user_id} · {r.duty_status}</option>)}</select>{!responders.length&&<p style={{color:'var(--reach-text-secondary)'}}>No responders are registered for this institution.</p>}</div></Modal>
  <Modal isOpen={callOpen} onClose={()=>setCallOpen(false)} title="Contact reporter" footer={<Button variant="ghost" onClick={()=>setCallOpen(false)}>Close</Button>}><div style={{display:'flex',flexDirection:'column',gap:'1rem'}}><p>Reporter contact details are restricted to authorized responders and configured communication providers.</p><p style={{color:'var(--reach-text-secondary)'}}>No live VoIP/SMS provider is configured in this MVP, so REACH will not pretend a call was placed.</p></div></Modal>
 </div>;
};
