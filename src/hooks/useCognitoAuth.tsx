import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { signIn, signUp, signOut, getCurrentUser, fetchAuthSession, resetPassword, confirmResetPassword, confirmSignIn, signInWithRedirect } from 'aws-amplify/auth';
import { apiService, getApiData } from '@/lib/apiService';
import { useQueryClient } from '@tanstack/react-query';

// Configure Amplify
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_AWS_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_AWS_COGNITO_CLIENT_ID,
      loginWith: {
        email: true,
        oauth: {
          domain: import.meta.env.VITE_COGNITO_DOMAIN,
          scopes: ['openid', 'email', 'profile'],
          redirectSignIn: [window.location.origin + '/'],
          redirectSignOut: [window.location.origin + '/'],
          responseType: 'code' as const,
        },
      },
    },
  },
});

interface User {
  id: string;
  userId: string;
  username: string;
  email?: string;
  name?: string;
}

interface AuthContextType {
  user: User | null;
  session: any | null;
  idToken: string | null; // Cognito ID token for API requests
  loading: boolean;
  isAdmin: boolean;
  isContributor: boolean;
  isLeadership: boolean;
  canEditTools: boolean;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: any }>;
  signIn: (email: string, password: string) => Promise<{ error: any }>;
  confirmSignIn: (newPassword: string) => Promise<{ error: any }>;
  signOut: () => Promise<{ error: any }>;
  resetPassword: (email: string) => Promise<{ error: any }>;
  confirmResetPassword: (email: string, code: string, newPassword: string) => Promise<{ error: any }>;
  signInWithRedirect: (provider: 'Google') => Promise<{ error: any }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<any | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(true);
  const [isContributor, setIsContributor] = useState(true);
  const [isLeadership, setIsLeadership] = useState(true);
  const [canEditTools, setCanEditTools] = useState(true);
  const queryClient = useQueryClient();

  const checkUserRole = useCallback(async (userId: string) => {
    try {
      // Fetch user's organization memberships to determine role
      // apiService automatically handles authentication
      const response = await apiService.get(`/organization_members?cognito_user_id=${encodeURIComponent(userId)}`);
      const data = getApiData(response);
      const memberships = Array.isArray(data) ? data : [];
      
      // Update TanStack Query cache so useProfile can reuse this data
      // This prevents duplicate API calls
      queryClient.setQueryData(['organization_memberships', userId], memberships);
      
      // Check if user has any active memberships with admin or contributor roles
      const hasAdminRole = memberships.some((m: any) => m.role === 'admin' && m.is_active !== false);
      const hasContributorRole = memberships.some((m: any) => m.role === 'contributor' && m.is_active !== false);
      const hasLeadershipRole = memberships.some((m: any) => m.role === 'leadership' && m.is_active !== false);
      
      // Leadership = admin or leadership role
      const isLeadershipRole = hasAdminRole || hasLeadershipRole;
      
      setIsAdmin(hasAdminRole);
      setIsContributor(hasContributorRole || hasLeadershipRole || hasAdminRole);
      setIsLeadership(isLeadershipRole);
      setCanEditTools(hasContributorRole || hasLeadershipRole || hasAdminRole);
    } catch (error) {
      console.error('Failed to check user role:', error);
      // On error, default to no permissions for security
      setIsAdmin(false);
      setIsContributor(false);
      setIsLeadership(false);
      setCanEditTools(false);
    }
  }, [queryClient]);

  // Token refresh is handled automatically by Amplify on-demand
  // When an API call is made with an expired access token, Amplify will:
  // 1. Use the refresh token to get a new access token
  // 2. Retry the API call with the new token
  // This eliminates unnecessary background refresh calls while maintaining session continuity

  useEffect(() => {
    const checkAuthState = async () => {
      try {
        const currentUser = await getCurrentUser();
        const session = await fetchAuthSession({ forceRefresh: false });
        
        // Get ID token from session for authenticated requests
        const idToken = session.tokens?.idToken?.toString();
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (idToken) {
          headers['Authorization'] = `Bearer ${idToken}`;
        }
        
        // Fetch profiles and check user role in parallel using Promise.allSettled
        // This ensures both API calls start simultaneously
        const [profileResult, roleResult] = await Promise.allSettled([
          // Fetch user's full name from profiles table
          fetch(
            `${import.meta.env.VITE_API_BASE_URL}/api/profiles?user_id=${currentUser.userId}`,
            { headers }
          ).then(async (response) => {
            if (response.ok) {
              const result = await response.json();
              const profiles = Array.isArray(result) ? result : (result?.data || []);
              const profile = profiles[0]; // Get first profile
              
              // Update TanStack Query cache so useProfile can reuse this data
              if (profile) {
                queryClient.setQueryData(['profile', currentUser.userId], profile);
              }
              
              return profile;
            }
            return null;
          }).catch(() => null),
          // Check user role (this also makes an API call) - run in parallel
          checkUserRole(currentUser.userId).catch(() => {
            // Error already handled in checkUserRole
          })
        ]);
        
        // Extract full name from profile result, fallback to Cognito attributes
        let fullName: string | undefined = undefined;
        if (profileResult.status === 'fulfilled' && profileResult.value?.full_name) {
          fullName = profileResult.value.full_name;
          console.log('🔍 [AUTH] Got name from profile:', fullName);
        } else {
          console.log('🔍 [AUTH] No profile found, checking Cognito ID token...');
          // Fallback to Cognito user attributes (for federated users like Google)
          const session = await fetchAuthSession();
          const idTokenPayload = session.tokens?.idToken?.payload;
          console.log('🔍 [AUTH] ID token payload:', idTokenPayload);
          if (idTokenPayload?.name) {
            fullName = idTokenPayload.name as string;
            console.log('🔍 [AUTH] Got name from ID token:', fullName);
          } else if (idTokenPayload?.given_name && idTokenPayload?.family_name) {
            fullName = `${idTokenPayload.given_name} ${idTokenPayload.family_name}`;
            console.log('🔍 [AUTH] Got name from given/family names:', fullName);
          } else {
            console.log('🔍 [AUTH] No name found in ID token');
          }
        }
        
        // Use email as username if available, otherwise use Cognito username
        const tokenEmail = session.tokens?.idToken?.payload?.email as string | undefined;
        const email = currentUser.signInDetails?.loginId || tokenEmail || currentUser.username;
        const username = email.includes('@') ? email : currentUser.username;
        
        const userData: User = {
          id: currentUser.userId,
          userId: currentUser.userId,
          username: username,
          email: email,
          name: fullName || email || currentUser.username
        };
        
        console.log('🔍 [AUTH] Final userData:', userData);
        console.log('🔍 [AUTH] fullName resolved to:', fullName);
        
        setUser(userData);
        setSession(session);
        setIdToken(idToken || null);
      } catch (error) {
        setUser(null);
        setSession(null);
        setIdToken(null);
        setIsAdmin(false);
        setIsContributor(false);
        setIsLeadership(false);
        setCanEditTools(false);
      } finally {
        setLoading(false);
      }
    };

    checkAuthState();
  }, [checkUserRole, queryClient]);

  const handleSignUp = async (email: string, password: string, fullName: string) => {
    try {
      await signUp({
        username: email,
        password,
        options: {
          userAttributes: {
            email,
            name: fullName,
          },
        },
      });
      return { error: null };
    } catch (error: any) {
      return { error };
    }
  };

  const handleSignIn = async (email: string, password: string) => {
    try {
      const result = await signIn({ username: email, password });
      
      if (result.isSignedIn) {
        const currentUser = await getCurrentUser();
        const session = await fetchAuthSession();
        
        // Fetch user's full name from profiles table (the correct source)
        let fullName: string | undefined = undefined;
        try {
          // Get ID token from session for authenticated request
          const idToken = session.tokens?.idToken?.toString();
          const headers: HeadersInit = { 'Content-Type': 'application/json' };
          if (idToken) {
            headers['Authorization'] = `Bearer ${idToken}`;
          }
          
          // Use profiles endpoint instead of organization_members
          // Profiles is the correct source for user display names
          const response = await fetch(
            `${import.meta.env.VITE_API_BASE_URL}/api/profiles?user_id=${currentUser.userId}`,
            { headers }
          );
          if (response.ok) {
            const result = await response.json();
            const profiles = Array.isArray(result) ? result : (result?.data || []);
            const profile = profiles[0]; // Get first profile
            if (profile?.full_name) {
              fullName = profile.full_name;
            }
          }
        } catch (error) {
          console.warn('Could not fetch user full name from profiles:', error);
        }
        
        // Use email as username if available, otherwise use Cognito username
        const emailValue = currentUser.signInDetails?.loginId || currentUser.username;
        const username = emailValue.includes('@') ? emailValue : currentUser.username;
        
        const userData: User = {
          id: currentUser.userId,
          userId: currentUser.userId,
          username: username,
          email: emailValue,
          name: fullName || emailValue || currentUser.username
        };
        
        setUser(userData);
        setSession(session);
        setIdToken(session.tokens?.idToken?.toString() || null);
        await checkUserRole(currentUser.userId);
      } else if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        // Return a specific error for password change requirement
        return { error: { message: 'Password change required', code: 'NEW_PASSWORD_REQUIRED' } };
      }
      
      return { error: null };
    } catch (error: any) {
      return { error };
    }
  };

  const handleConfirmSignIn = async (newPassword: string) => {
    try {
      const result = await confirmSignIn({ challengeResponse: newPassword });
      
      if (result.isSignedIn) {
        const currentUser = await getCurrentUser();
        const session = await fetchAuthSession();
        
        const userData: User = {
          id: currentUser.userId,
          userId: currentUser.userId,
          username: currentUser.username,
          email: currentUser.signInDetails?.loginId,
          name: currentUser.username
        };
        
        setUser(userData);
        setSession(session);
        await checkUserRole(currentUser.userId);
      }
      
      return { error: null };
    } catch (error: any) {
      return { error };
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setUser(null);
      setSession(null);
      setIsAdmin(false);
      setIsContributor(false);
      setIsLeadership(false);
      setCanEditTools(false);
      return { error: null };
    } catch (error: any) {
      return { error };
    }
  };

  const handleResetPassword = async (email: string) => {
    try {
      await resetPassword({ username: email });
      return { error: null };
    } catch (error: any) {
      return { error };
    }
  };

  const handleConfirmResetPassword = async (email: string, code: string, newPassword: string) => {
    try {
      await confirmResetPassword({
        username: email,
        confirmationCode: code,
        newPassword: newPassword,
      });
      // Auto-sign-in after successful reset so user doesn't have to re-enter credentials
      return await handleSignIn(email, newPassword);
    } catch (error: any) {
      return { error };
    }
  };

  const handleSignInWithRedirect = async (provider: 'Google') => {
    try {
      await signInWithRedirect({ provider: { custom: provider } });
      return { error: null };
    } catch (error: any) {
      return { error };
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      idToken,
      loading,
      isAdmin,
      isContributor,
      isLeadership,
      canEditTools,
      signUp: handleSignUp,
      signIn: handleSignIn,
      confirmSignIn: handleConfirmSignIn,
      signOut: handleSignOut,
      resetPassword: handleResetPassword,
      confirmResetPassword: handleConfirmResetPassword,
      signInWithRedirect: handleSignInWithRedirect,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
