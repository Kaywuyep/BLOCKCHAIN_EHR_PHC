import { Link } from 'react-router-dom';

const ROLES = [
  {
    path: '/patient',
    eyebrow: 'For patients',
    title: 'Patient App',
    description:
      "Register your PatientChain DID, link facilities you already have a record at, and control who can see your records.",
    bullets: ['Link a facility off-chain, never on-chain', 'Approve or revoke access grants', 'See your full audit trail'],
  },
  {
    path: '/clinician',
    eyebrow: 'For clinicians',
    title: 'Clinician Portal',
    description: 'Request scoped, purpose-limited access to a patient\'s records and resolve them via the FHIR Adapter.',
    bullets: ['Request access with a declared purpose', 'Pull records only once a grant is active', 'Break-glass for emergencies'],
  },
  {
    path: '/admin',
    eyebrow: 'For hospital admins',
    title: 'Admin Dashboard',
    description: 'Oversee hospitals, providers, access policies and system health across the network.',
    bullets: ['Review break-glass access', 'Monitor audit logs', 'Track system health & cost'],
  },
];

export function Landing() {
  return (
    <div>
      <div className="hero">
        <span className="eyebrow">Blockchain-based patient-controlled access &amp; reference system</span>
        <h1>PatientChain</h1>
        <p>
          PatientChain gives every patient one portable identity across hospitals, while keeping clinical records
          exactly where they already live. Access references and audit history are recorded on-chain; the records
          themselves, and the demographics used to link a facility, never leave the hospital that holds them.
        </p>
      </div>

      <div className="role-grid">
        {ROLES.map((role) => (
          <Link key={role.path} to={role.path} className="role-card">
            <span className="eyebrow">{role.eyebrow}</span>
            <h2>{role.title}</h2>
            <p>{role.description}</p>
            <ul>
              {role.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            <span className="role-card-cta">Enter →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
