import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useCognitoAuth';
import { apiService } from '@/lib/apiService';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { getCurrentUser } from 'aws-amplify/auth';

interface InviteData {
  email: string;
  organizationId: string;
  organizationName: string;
}

type Step = 'loading' | 'choose' | 'password' | 'success' | 'error' | 'already-signed-in';

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, signIn, signInWithRedirect, signOut } = useAuth();

  const [step, setStep] = useState<Step>('loading');
  const [inviteData, setInviteData] = useState<InviteData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const token = searchParams.get('token') || '';

  // On mount: validate token OR detect returning OAuth user
  useEffect(() => {
    const init = async () => {
      // Check if returning from Google OAuth (invited email stored before redirect)
      const invitedEmail = sessionStorage.getItem('cwf_invite_email');
      if (invitedEmail) {
        try {
          const currentUser = await getCurrentUser();
          const userEmail = currentUser.signInDetails?.loginId || currentUser.username;

          if (userEmail !== invitedEmail) {
            sessionStorage.removeItem('cwf_invite_email');
            setError('The Google account you signed in with does not match the invited email. Please try again.');
            setStep('error');
            return;
          }

          // Email matches — activate the account (clears FORCE_CHANGE_PASSWORD)
          await apiService.post('/activate-user-account', { email: userEmail });
          sessionStorage.removeItem('cwf_invite_email');
          setStep('success');
          setTimeout(() => navigate('/dashboard'), 2000);
          return;
        } catch {
          // Not authenticated yet — continue with token validation below
        }
      }

      if (!token) {
        setError('No invitation token found. Please use the link from your invitation email.');
        setStep('error');
        return;
      }

      try {
        const result = await apiService.post('/validate-invite-token', { token });
        const data = result?.data || result;
        if (data.valid) {
          setInviteData({ email: data.email, organizationId: data.organizationId, organizationName: data.organizationName });

          // Check if user is already signed in as a different account
          try {
            const currentUser = await getCurrentUser();
            const session = await (await import('aws-amplify/auth')).fetchAuthSession();
            const tokenEmail = session.tokens?.idToken?.payload?.email as string | undefined;
            const currentEmail = currentUser.signInDetails?.loginId || tokenEmail || currentUser.username;
            if (currentEmail && currentEmail !== data.email) {
              setStep('already-signed-in');
              return;
            }
          } catch {
            // Not signed in — continue to choose step
          }

          setStep('choose');
        } else {
          setError(data.error || 'This invitation link is invalid or has expired.');
          setStep('error');
        }
      } catch {
        setError('Failed to validate invitation. Please try again or request a new invitation.');
        setStep('error');
      }
    };

    init();
  }, [token, navigate]);

  const handleGoogleSignIn = async () => {
    if (!inviteData) return;
    sessionStorage.setItem('cwf_invite_email', inviteData.email);
    await signInWithRedirect('Google');
    // Page will redirect — no further code runs
  };

  const handlePasswordSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!inviteData) return;

    const formData = new FormData(e.currentTarget);
    const password = formData.get('password') as string;
    const confirmPassword = formData.get('confirmPassword') as string;

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Activate account with chosen password
      await apiService.post('/activate-user-password', { email: inviteData.email, password, token });

      // Auto sign-in
      const { error: signInError } = await signIn(inviteData.email, password);
      if (signInError) {
        setError(signInError.message);
        setLoading(false);
        return;
      }

      setStep('success');
      setTimeout(() => navigate('/dashboard'), 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to activate account. Please try again.');
      setLoading(false);
    }
  };

  if (step === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center space-y-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Processing your invitation...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (step === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center space-y-4">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <h2 className="text-xl font-semibold">Welcome{inviteData ? ` to ${inviteData.organizationName}` : ''}!</h2>
              <p className="text-muted-foreground text-center">Your account is active. Redirecting to dashboard...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Invitation Error
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Button onClick={() => navigate('/auth')} className="w-full">Go to Login</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (step === 'password') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Create Your Password</CardTitle>
            <CardDescription>Setting up account for {inviteData?.email}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" required minLength={8} disabled={loading} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={8} disabled={loading} />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Activating...</> : 'Activate Account'}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => setStep('choose')} disabled={loading}>
                Back
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // step === 'already-signed-in'
  if (step === 'already-signed-in') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Already Signed In
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertDescription>
                You're currently signed in as a different user. To accept this invitation for <strong>{inviteData?.email}</strong>, you need to sign out first.
              </AlertDescription>
            </Alert>
            <Button
              onClick={async () => {
                await signOut();
                // Reload the page so the invite flow starts fresh
                window.location.reload();
              }}
              className="w-full"
            >
              Sign Out & Continue
            </Button>
            <Button variant="ghost" onClick={() => navigate('/dashboard')} className="w-full">
              Go to Dashboard Instead
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // step === 'choose'
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Activate Your Account</CardTitle>
          <CardDescription>
            You've been invited to join <strong>{inviteData?.organizationName}</strong> ({inviteData?.email})
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

          <Button type="button" variant="outline" className="w-full" onClick={handleGoogleSignIn}>
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">Or</span>
            </div>
          </div>

          <Button type="button" className="w-full" onClick={() => setStep('password')}>
            Create a Password
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
