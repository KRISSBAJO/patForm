'use client';

import { useEffect, useState } from 'react';
import '../sign.css';

/** Hosted processors return to this generic page. The personal signer link is
 * kept in sessionStorage, never placed in the provider callback URL. */
export default function PaymentComplete() {
  const [recoverable, setRecoverable] = useState(true);
  useEffect(() => {
    const token = sessionStorage.getItem('patform-sign-resume');
    sessionStorage.removeItem('patform-sign-resume');
    if (token && /^[A-Za-z0-9_-]{30,60}$/.test(token)) window.location.replace(`/sign/${token}?payment=return`);
    else setRecoverable(false);
  }, []);
  return <main className="ps"><div className="ps__main"><div className="ps__card"><h1>{recoverable ? 'Returning to your agreement…' : 'Return to your agreement'}</h1>
    <p className="ps__muted">{recoverable ? 'We are checking your payment with the provider.' : 'Open the personal signing link from your email to continue. Your payment will be checked there before the agreement is completed.'}</p>
  </div></div></main>;
}
