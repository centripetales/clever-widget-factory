import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from "@/hooks/useCognitoAuth";
import { useToast } from '@/hooks/use-toast';

const Auth = () => {
  const navigate = useNavigate();
  const { user, signIn, confirmSignIn, resetPassword, confirmResetPassword, signInWithRedirect } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsPasswordChange, setNeedsPasswordChange] = useState(false);
  const [showResetForm, setShowResetForm] = useState(false);
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');
  const [resetEmail, setResetEmail] = useState('');

  useEffect(() => {
    if (user) navigate('/dashboard');
  }, [user, navigate]);

  const handleSignIn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    setLoading(true);
    setError('');

    const { error } = await signIn(email, password);

    if (error) {
      if (error.code === 'NEW_PASSWORD_REQUIRED') {
        setNeedsPasswordChange(true);
      } else {
        setError(error.message);
      }
    } else {
      toast({ title: "Welcome back!", description: "You have successfully signed in." });
    }

    setLoading(false);
  };

  const handleConfirmSignIn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newPassword = formData.get('newPassword') as string;

    setLoading(true);
    setError('');

    const { error } = await confirmSignIn(newPassword);

    if (error) {
      setError(error.message);
    } else {
      toast({ title: "Password updated", description: "You have successfully signed in." });
      setNeedsPasswordChange(false);
    }

    setLoading(false);
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError('');

    const { error } = await signInWithRedirect('Google');

    if (error) {
      setError(error.message);
      setLoading(false);
    }
    // No setLoading(false) on success — user is being redirected
  };

  const handleResetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;

    setLoading(true);
    setError('');

    const { error } = await resetPassword(email);

    if (error) {
      setError(error.message);
    } else {
      setResetEmail(email);
      setResetStep('confirm');
      toast({ title: "Reset code sent", description: "Check your email for the verification code." });
    }

    setLoading(false);
  };

  const handleConfirmResetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const code = formData.get('code') as string;
    const newPassword = formData.get('newPassword') as string;
    const confirmPassword = formData.get('confirmPassword') as string;

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    setError('');

    // confirmResetPassword auto-signs-in on success
    const { error } = await confirmResetPassword(resetEmail, code, newPassword);

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      toast({ title: "Password reset successful", description: "Signing you in..." });
      // Navigation handled by useEffect when user state updates
    }
  };

  const header = (
    <CardHeader className="text-center">
      <div className="flex justify-center mb-4">
        <img src="/logo_only_with_diamond_bg.svg" alt="Stargazer Farm" className="h-20 w-20" />
      </div>
      <CardTitle className="text-3xl font-bold mb-2">Stargazer Farm</CardTitle>
      <p className="text-lg font-medium">AI-Assisted Project & Inventory Management</p>
    </CardHeader>
  );

  const footer = (
    <div className="flex gap-2 justify-center pb-2">
      <Button variant="outline" onClick={() => window.open('https://www.facebook.com/stargazerfarminc/', '_blank')}>
        Contact Us
      </Button>
    </div>
  );

  if (needsPasswordChange) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          {header}
          <CardContent className="space-y-4">
            <div className="text-center">
              <h3 className="text-lg font-semibold">Set New Password</h3>
              <p className="text-sm text-muted-foreground">You must set a new password to continue</p>
            </div>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <form onSubmit={handleConfirmSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <Input id="newPassword" name="newPassword" type="password" required disabled={loading} />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Setting Password...' : 'Set Password'}
              </Button>
            </form>
            {footer}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (showResetForm) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          {header}
          <CardContent className="space-y-4">
            {resetStep === 'request' ? (
              <>
                <div className="text-center">
                  <h3 className="text-lg font-semibold">Reset Password</h3>
                  <p className="text-sm text-muted-foreground">Enter your email to receive a verification code</p>
                </div>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" name="email" type="email" required disabled={loading} />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? 'Sending...' : 'Send Reset Code'}
                  </Button>
                  <Button type="button" variant="ghost" className="w-full" onClick={() => setShowResetForm(false)} disabled={loading}>
                    Back to Sign In
                  </Button>
                </form>
              </>
            ) : (
              <>
                <div className="text-center">
                  <h3 className="text-lg font-semibold">Enter Reset Code</h3>
                  <p className="text-sm text-muted-foreground">Enter the code sent to {resetEmail}</p>
                </div>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <form onSubmit={handleConfirmResetPassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="code">Verification Code</Label>
                    <Input id="code" name="code" type="text" required disabled={loading} placeholder="Enter 6-digit code" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">New Password</Label>
                    <Input id="newPassword" name="newPassword" type="password" required disabled={loading} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm Password</Label>
                    <Input id="confirmPassword" name="confirmPassword" type="password" required disabled={loading} />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? 'Resetting...' : 'Reset Password'}
                  </Button>
                  <Button type="button" variant="ghost" className="w-full" onClick={() => { setResetStep('request'); setError(''); }} disabled={loading}>
                    Back to Email
                  </Button>
                </form>
              </>
            )}
            {footer}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        {header}
        <CardContent className="space-y-4">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required disabled={loading} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required disabled={loading} />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Signing In...' : 'Sign In'}
            </Button>
          </form>

          <div className="text-center">
            <Button type="button" variant="link" onClick={() => setShowResetForm(true)} disabled={loading}>
              Forgot your password?
            </Button>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">Or</span>
            </div>
          </div>

          <Button type="button" variant="outline" className="w-full" onClick={handleGoogleSignIn} disabled={loading}>
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </Button>

          {footer}
        </CardContent>
      </Card>
    </div>
  );
};

export default Auth;
