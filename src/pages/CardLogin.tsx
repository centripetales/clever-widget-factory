import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { signIn, confirmSignIn } from 'aws-amplify/auth';
import { Loader2, AlertCircle } from 'lucide-react';
import '@/hooks/useCognitoAuth'; // configures Amplify

// An NFC card opens /card/<secret>. The secret is swapped for the holder's sign-in
// name and a short-lived proof, which answers Cognito's custom-auth challenge.
export default function CardLogin() {
  const { secret = '' } = useParams();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/card-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret }),
        });
        if (!response.ok) throw new Error('This card is not valid.');
        const { email, proof } = await response.json();

        // Whoever was signed in on this device is replaced by the card's holder. Amplify's signOut
        // sends a Google-originated session through Cognito's logout page, which navigates away
        // mid-sign-in, so the old session's tokens are cleared locally instead.
        Object.keys(localStorage)
          .filter((key) => key.startsWith('CognitoIdentityServiceProvider') || key.startsWith('amplify-'))
          .forEach((key) => localStorage.removeItem(key));

        const first = await signIn({ username: email, options: { authFlowType: 'CUSTOM_WITHOUT_SRP' } });
        if (first.nextStep.signInStep !== 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE') {
          throw new Error(`Unexpected sign-in step: ${first.nextStep.signInStep}`);
        }
        const second = await confirmSignIn({ challengeResponse: proof });
        if (!second.isSignedIn) throw new Error('Sign-in did not complete.');

        // A full load starts the app from the new session; replace drops the secret from history.
        window.location.replace('/');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
      }
    };
    run();
  }, [secret]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      {error ? (
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span>{error}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Signing you in…</span>
        </div>
      )}
    </div>
  );
}
