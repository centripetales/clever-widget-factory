import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { apiService } from '@/lib/apiService';
import { useOrganization } from './useOrganization';

interface PendingInvitation {
  id: string;
  email: string;
  user_metadata: {
    organization_id: string;
    organization_name: string;
    role: string;
  };
  invited_at: string;
  email_confirmed_at: string | null;
}

interface Organization {
  id: string;
  name: string;
  subdomain?: string | null;
  settings?: any;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface UseInvitationsOptions {
  organization?: Organization | null;
  isAdmin?: boolean;
}

export function useInvitations(options?: UseInvitationsOptions) {
  const { toast } = useToast();
  const { organization: defaultOrganization, isAdmin: defaultIsAdmin } = useOrganization();
  const [loading, setLoading] = useState(false);

  // Use provided organization/admin or fall back to context
  const organization = options?.organization ?? defaultOrganization;
  const isAdmin = options?.isAdmin ?? defaultIsAdmin;

  const sendInvitation = async (email: string, role: string = 'user') => {
    if (!organization || !isAdmin) {
      toast({
        title: "Error",
        description: "You don't have permission to send invitations",
        variant: "destructive",
      });
      return null;
    }

    setLoading(true);
    try {
      // Send invitation via API
      const data = await apiService.post('/invite-user', {
        email,
        organizationId: organization.id,
        organizationName: organization.name,
        role,
      });

      toast({
        title: "Success",
        description: `Magic link invitation sent to ${email}`,
      });

      return data;
    } catch (error) {
      console.error('Error sending invitation:', error);
      toast({
        title: "Error",
        description: "Failed to send invitation",
        variant: "destructive",
      });
      return null;
    } finally {
      setLoading(false);
    }
  };

  const getPendingInvitations = async () => {
    if (!organization) return [];

    try {
      // For now, we'll return an empty array since admin.listUsers requires service role
      // In production, this would be called from an edge function with proper admin access
      return [];
    } catch (error) {
      console.error('Error fetching pending invitations:', error);
      return [];
    }
  };

  const revokeInvitation = async (userId: string) => {
    if (!isAdmin) {
      toast({
        title: "Error",
        description: "You don't have permission to revoke invitations",
        variant: "destructive",
      });
      return false;
    }

    try {
      // Delete the user to revoke the invitation
      await apiService.delete(`/api/users/${userId}`);

      toast({
        title: "Success",
        description: "Invitation revoked successfully",
      });
      return true;
    } catch (error) {
      console.error('Error revoking invitation:', error);
      toast({
        title: "Error",
        description: "Failed to revoke invitation",
        variant: "destructive",
      });
      return false;
    }
  };

  return {
    sendInvitation,
    getPendingInvitations,
    revokeInvitation,
    loading,
  };
}