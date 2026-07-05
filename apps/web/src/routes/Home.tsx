import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <section>
      <h1>Invoicing Platform</h1>
      <p>Customer invoicing, payments, and QuickBooks sync, in one place.</p>
      <p>
        <Link to="/login">Sign in</Link>
      </p>
    </section>
  );
}
