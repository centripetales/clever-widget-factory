import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from "@/hooks/useCognitoAuth";
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Trash2, Send, Users, Shield, User, Wrench, Star, Info, ToggleLeft, ToggleRight, ChevronDown, UserX, ArrowLeft, MessageSquare, Copy, Check, Link } from 'lucide-react';
import { EditableOrganizationName } from '@/components/EditableOrganizationName';
import { EditableMemberName } from '@/components/EditableMemberName';
import { EditableOrganizationDomain } from '@/components/EditableOrganizationDomain';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useOrganization } from '@/hooks/useOrganization';
import { useInvitations } from '@/hooks/useInvitations';
import { useToast } from '@/hooks/use-toast';
import { useSuperAdmin } from '@/hooks/useSuperAdmin';
import { useProfile } from '@/hooks/useProfile';
import { OrganizationValuesSection } from '@/components/OrganizationValuesSection';
import { AiConfigCard } from '@/components/AiConfigCard';
import { LensManagementCard } from '@/components/LensManagementCard';
import { apiService, getApiData } from '@/lib/apiService';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useOrganizationMembersByOrg } from '@/hooks/useOrganizationMembers';


interface OrganizationMember {
  id: string;
  user_id: string;
  role: string;
  is_active: boolean;
  status?: string;
  full_name: string | null;
  auth_data?: {
    email: string;
    last_sign_in_at: string | null;
    created_at: string;
  };
}

const Organization = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { organizationId } = useParams();
  const { organization: currentOrg } = useOrganization();
  const { updateOrganization } = useOrganizations();
  const { isSuperAdmin, loading: superAdminLoading } = useSuperAdmin();
  const { allMemberships, isLoading: profileLoading } = useProfile();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  // Use the organization from URL param or fallback to current user's org
  const targetOrgId = organizationId || currentOrg?.id;
  const [targetOrganization, setTargetOrganization] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoadingOrg, setIsLoadingOrg] = useState(true);
  const [orgLoadError, setOrgLoadError] = useState<string | null>(null);
  
  const [newInviteEmail, setNewInviteEmail] = useState('');
  const [newInviteRole, setNewInviteRole] = useState('user');
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  
  // Track which member is currently being updated
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  
  // Use TanStack Query for organization members
  const resolvedOrgId = targetOrganization?.id || targetOrgId;
  const { members, pendingMembers, loading: membersLoading, refetch: refetchMembers } = useOrganizationMembersByOrg(resolvedOrgId);

  const targetMembership = useMemo(() => {
    if (!resolvedOrgId || !Array.isArray(allMemberships)) return null;
    return allMemberships.find((membership) => membership.organization_id === resolvedOrgId) || null;
  }, [allMemberships, resolvedOrgId]);


  const loadOrganizationData = useCallback(async () => {
    if (superAdminLoading || profileLoading) {
      return;
    }

    setIsLoadingOrg(true);
    setOrgLoadError(null);
    try {
      const response = await apiService.get('/organizations');
      const organizations = getApiData(response) || [];

      if (!organizations.length) {
        console.warn('[Organization] No organizations found');
        setTargetOrganization(null);
        setIsAdmin(isSuperAdmin || false);
        setOrgLoadError('No organizations found');
        setIsLoadingOrg(false);
        return;
      }

      let selectedOrganization = targetOrgId
        ? organizations.find((org: any) => org.id === targetOrgId)
        : null;

      if (!selectedOrganization) {
        selectedOrganization = organizations[0];
      }

      if (selectedOrganization) {
        setTargetOrganization(selectedOrganization);

        const membershipForOrg = Array.isArray(allMemberships) 
          ? allMemberships.find(
              (membership) => membership.organization_id === selectedOrganization.id
            )
          : null;

        if (isSuperAdmin) {
          setIsAdmin(true);
        } else {
          const isOrgAdmin = membershipForOrg?.role === 'admin';
          setIsAdmin(!!isOrgAdmin);
        }
      }
    } catch (error: any) {
      console.error('[Organization] Error in loadOrganizationData:', error);
      const errorMessage = error?.message || error?.error?.message || 'Failed to load organizations';
      setOrgLoadError(errorMessage);
      setIsAdmin(isSuperAdmin || false);
      toast({
        title: "Error",
        description: `Failed to load organization data: ${errorMessage}`,
        variant: "destructive",
      });
    } finally {
      setIsLoadingOrg(false);
    }
  }, [targetOrgId, isSuperAdmin, superAdminLoading, profileLoading, allMemberships, toast]);

  // Members are now loaded via TanStack Query hook above

  // Pass target organization and admin status to useInvitations
  const { sendInvitation, loading } = useInvitations({
    organization: targetOrganization,
    isAdmin: isAdmin,
  });

  useEffect(() => {
    if (!superAdminLoading && !profileLoading) {
      loadOrganizationData();
    }
  }, [loadOrganizationData, superAdminLoading, profileLoading]);

  // Members are now automatically loaded via useOrganizationMembersByOrg hook
  // No need for useEffect - TanStack Query handles fetching when resolvedOrgId changes

  const handleSendInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const result = await sendInvitation(newInviteEmail, newInviteRole);
    if (result) {
      setNewInviteEmail('');
      setNewInviteRole('user');
      setLastInviteLink(result.inviteLink || null);
      setLinkCopied(false);
      refetchMembers(); // Refresh to show new pending invitation
    }
  };

  const handleCopyInviteLink = async () => {
    if (!lastInviteLink) return;
    try {
      await navigator.clipboard.writeText(lastInviteLink);
      setLinkCopied(true);
      toast({ title: "Copied!", description: "Invite link copied to clipboard" });
      setTimeout(() => setLinkCopied(false), 3000);
    } catch {
      // Fallback for browsers that don't support clipboard API
      const textArea = document.createElement('textarea');
      textArea.value = lastInviteLink;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setLinkCopied(true);
      toast({ title: "Copied!", description: "Invite link copied to clipboard" });
      setTimeout(() => setLinkCopied(false), 3000);
    }
  };


  const handleRevokePendingMember = async (memberId: string) => {
    if (!isAdmin) return;

    try {
      await apiService.delete(`/organization_members?id=${memberId}`);

      toast({
        title: "Success",
        description: "Pending invitation revoked",
      });
      
      // Invalidate cache to refetch and update UI
      queryClient.invalidateQueries({ queryKey: ['organization_members', resolvedOrgId] });
      queryClient.invalidateQueries({ queryKey: ['organization_members'] });
    } catch (error) {
      console.error('Error revoking pending membership:', error);
      toast({
        title: "Error",
        description: "Failed to revoke invitation",
        variant: "destructive",
      });
    }
  };


  const toggleMemberStatusMutation = useMutation({
    mutationFn: async ({ memberId, currentStatus }: { memberId: string; currentStatus: boolean }) => {
      const response = await apiService.put('/organization_members', {
        id: memberId,
        is_active: !currentStatus
      });
      return response;
    },
    onMutate: async ({ memberId, currentStatus }) => {
      setUpdatingMemberId(memberId);
    },
    onSuccess: (response, variables) => {
      setUpdatingMemberId(null);
      
      // Invalidate all member caches to force refetch with latest data
      queryClient.invalidateQueries({ queryKey: ['organization_members'] });
      if (resolvedOrgId) {
        queryClient.invalidateQueries({ queryKey: ['organization_members', resolvedOrgId] });
      }
      
      toast({
        title: "Success",
        description: `Member ${!variables.currentStatus ? 'enabled' : 'disabled'} successfully`,
      });
    },
    onError: (error, variables) => {
      console.error('[toggleMemberStatus] onError', { error, variables });
      setUpdatingMemberId(null);
      
      toast({
        title: "Error",
        description: `Failed to update member status: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive",
      });
    },
  });

  const toggleMemberStatus = (memberId: string, currentStatus: boolean) => {
    toggleMemberStatusMutation.mutate({ memberId, currentStatus });
  };

  const handleRemoveMember = async (memberId: string, memberName: string) => {
    if (!isAdmin) return;

    const confirmed = window.confirm(`Are you sure you want to remove ${memberName}? This will disable their account.`);
    if (!confirmed) return;

    try {
      await apiService.delete(`/organization_members?id=${memberId}`);

      toast({
        title: "Success",
        description: `${memberName} has been removed`,
      });
      
      // Invalidate cache to refetch and update UI
      queryClient.invalidateQueries({ queryKey: ['organization_members', resolvedOrgId] });
      queryClient.invalidateQueries({ queryKey: ['organization_members'] });
    } catch (error) {
      console.error('Error removing member:', error);
      toast({
        title: "Error",
        description: "Failed to remove member",
        variant: "destructive",
      });
    }
  };

  const handleRoleChangeMutation = useMutation({
    mutationFn: async ({ memberId, newRole }: { memberId: string; newRole: string }) => {
      return await apiService.put('/organization_members', {
        id: memberId,
        role: newRole
      });
    },
    onMutate: async ({ memberId, newRole }) => {
      // Just track that we're updating
    },
    onSuccess: (response, variables) => {
      // Invalidate all member caches to force refetch with latest data
      queryClient.invalidateQueries({ queryKey: ['organization_members'] });
      if (resolvedOrgId) {
        queryClient.invalidateQueries({ queryKey: ['organization_members', resolvedOrgId] });
      }
      
      toast({
        title: "Success",
        description: `Member's role has been updated to ${variables.newRole}`,
      });
    },
    onError: (error, variables) => {
      console.error('Error updating member role:', error);
      
      toast({
        title: "Error",
        description: "Failed to update member role",
        variant: "destructive",
      });
    },
  });

  const handleRoleChange = (memberId: string, newRole: string, memberName: string) => {
    if (!isAdmin) return;
    handleRoleChangeMutation.mutate({ memberId, newRole });
  };

  if (isLoadingOrg || !targetOrganization) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-6">
            {isLoadingOrg ? (
              <div className="space-y-2">
                <p>Loading organization data...</p>
                {superAdminLoading && <p className="text-sm text-muted-foreground">Loading admin status...</p>}
                {profileLoading && <p className="text-sm text-muted-foreground">Loading profile...</p>}
              </div>
            ) : orgLoadError ? (
              <div className="space-y-4">
                <p className="text-destructive font-semibold">Error loading organization data</p>
                <p className="text-sm text-muted-foreground">{orgLoadError}</p>
                {orgLoadError.includes('403') || orgLoadError.includes('Forbidden') || orgLoadError.includes('not authorized') ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      This might be a permissions issue. Please check:
                    </p>
                    <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                      <li>You are logged in with the correct account</li>
                      <li>Your account has organization memberships</li>
                      <li>Your organization memberships are enabled</li>
                    </ul>
                  </div>
                ) : null}
                <Button onClick={() => {
                  setIsLoadingOrg(true);
                  setOrgLoadError(null);
                  loadOrganizationData();
                }}>Retry</Button>
              </div>
            ) : (
              <div className="space-y-4">
                <p>No organization found</p>
                <p className="text-sm text-muted-foreground">
                  You may need to be added to an organization first.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-3xl font-bold">Organization Settings</h1>
        </div>
      </div>

      {/* Organization Info */}
      <Card>
        <CardHeader>
          <CardTitle>Organization Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Organization Name</Label>
            <EditableOrganizationName
              organizationId={targetOrganization.id}
              currentName={targetOrganization.name}
              onNameUpdated={loadOrganizationData}
              canEdit={isAdmin}
            />
          </div>
          <div>
            <Label>Domain</Label>
            <EditableOrganizationDomain
              organizationId={targetOrganization.id}
              currentDomain={targetOrganization.subdomain}
              onDomainUpdated={loadOrganizationData}
              canEdit={isAdmin}
            />
          </div>
        </CardContent>
      </Card>

      {/* Organization Values */}
      <OrganizationValuesSection canEdit={isAdmin} organization={targetOrganization} />

      {/* Scoring Prompts */}
      {isAdmin && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                AI Scoring Prompts
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Manage AI prompts used for automated action scoring and accountability assessments.
              </p>
              <Button onClick={() => navigate('/prompts')} variant="outline">
                <MessageSquare className="w-4 h-4 mr-2" />
                Manage Scoring Prompts
              </Button>
            </CardContent>
          </Card>

          {/* AI Configuration */}
          <AiConfigCard organizationId={targetOrganization.id} />

          {/* Lens Management */}
          <LensManagementCard
            organizationId={targetOrganization.id}
            strategicAttributes={targetOrganization.settings?.strategic_attributes || []}
          />
        </>
      )}

      {/* Roles & Permissions */}
      <Collapsible defaultOpen={false}>
        <Card>
          <CollapsibleTrigger className="w-full">
            <CardHeader className="hover:bg-muted/50 transition-colors">
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="w-5 h-5" />
                  Roles & Permissions
                </div>
                <ChevronDown className="w-5 h-5 transition-transform group-data-[state=open]:rotate-180" />
              </CardTitle>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* User Role */}
            <div className="p-4 border rounded-lg bg-muted/20">
              <div className="flex items-center gap-2 mb-3">
                <User className="w-5 h-5 text-blue-600" />
                <h3 className="font-semibold text-foreground">User</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                Basic member with standard access to organization resources.
              </p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• View tools and inventory</li>
                <li>• Check out/in tools</li>
                <li>• Participate in missions</li>
                <li>• Report issues</li>
                <li>• View own activities</li>
              </ul>
            </div>

            {/* Contributor Role */}
            <div className="p-4 border rounded-lg bg-muted/20">
              <div className="flex items-center gap-2 mb-3">
                <Star className="w-5 h-5 text-green-600" />
                <h3 className="font-semibold text-foreground">Contributor</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                Enhanced member who can create and manage content, tools, and inventory.
              </p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• All User permissions</li>
                <li>• Create missions and actions</li>
                <li>• Edit mission details</li>
                <li>• Add/edit tools and inventory (with history tracking)</li>
                <li>• Manage tool maintenance</li>
                <li>• Manage mission attachments</li>
                <li>• Generate reports</li>
              </ul>
            </div>

            {/* Admin Role */}
            <div className="p-4 border rounded-lg bg-muted/20">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-5 h-5 text-purple-600" />
                <h3 className="font-semibold text-foreground">Admin</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                Full administrative access with member management and strategic oversight capabilities.
              </p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• All Contributor permissions</li>
                <li>• Manage organization members</li>
                <li>• Send/revoke invitations</li>
                <li>• Edit organization settings</li>
                <li>• Access analytics</li>
                <li>• Strategic planning tools</li>
                <li>• Performance analytics</li>
                <li>• Worker attribute management</li>
                <li>• Organizational reporting</li>
              </ul>
            </div>
          </div>
          
          <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-blue-900 dark:text-blue-100 mb-1">Role Assignment</p>
                <p className="text-blue-700 dark:text-blue-200">
                  Roles are hierarchical - higher roles inherit all permissions from lower roles. 
                  Choose the appropriate role based on the level of access and responsibility needed.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
        </CollapsibleContent>
      </Card>
      </Collapsible>

      {/* Invitation Management (Admin Only) */}
      {isAdmin && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Send Invitation</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSendInvitation} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <Label htmlFor="email">Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      value={newInviteEmail}
                      onChange={(e) => setNewInviteEmail(e.target.value)}
                      placeholder="user@example.com"
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="role">Role</Label>
                    <Select value={newInviteRole} onValueChange={setNewInviteRole}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4" />
                            <span>User - Basic member access</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="contributor">
                          <div className="flex items-center gap-2">
                            <Star className="w-4 h-4" />
                            <span>Contributor - Create content</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="leadership">
                          <div className="flex items-center gap-2">
                            <Shield className="w-4 h-4" />
                            <span>Leadership - Manage org data</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="admin">
                          <div className="flex items-center gap-2">
                            <Shield className="w-4 h-4" />
                            <span>Admin - Manage members</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end">
                    <Button type="submit" disabled={loading} className="w-full">
                      <Send className="w-4 h-4 mr-2" />
                      {loading ? 'Sending...' : 'Send Invitation'}
                    </Button>
                  </div>
                </div>
              </form>

              {/* Invite Link Display */}
              {lastInviteLink && (
                <div className="mt-4 p-4 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Link className="w-4 h-4 text-green-600" />
                    <span className="text-sm font-medium text-green-900 dark:text-green-100">Invite Link Ready</span>
                  </div>
                  <p className="text-xs text-green-700 dark:text-green-300 mb-3">
                    Share this link with the invited user. It expires in 24 hours.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={lastInviteLink}
                      className="text-xs font-mono bg-white dark:bg-gray-900"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCopyInviteLink}
                      className="shrink-0"
                    >
                      {linkCopied ? (
                        <><Check className="w-4 h-4 mr-1 text-green-600" /> Copied</>
                      ) : (
                        <><Copy className="w-4 h-4 mr-1" /> Copy</>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                Organization Members
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Organization Members */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  <h3 className="text-lg font-semibold">Organization Members ({members.length})</h3>
                </div>
                
                {members.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">No members found</p>
                ) : (
                  <div className="space-y-2">
                    {members.map((member) => (
                       <div key={member.id} className="flex items-center justify-between p-3 border rounded-lg bg-muted/20">
                         <div className="flex-1">
                           <EditableMemberName 
                             memberId={member.id}
                             currentName={member.full_name}
                             email={member.auth_data?.email || 'No email available'}
                             onNameUpdated={refetchMembers}
                           />
                           <div className="text-sm text-muted-foreground">{member.auth_data?.email || 'No email available'}</div>
                           <div className="flex items-center gap-2 text-sm">
                             <span className="text-muted-foreground">Role:</span>
                             {isAdmin ? (
                               <Select value={member.role} onValueChange={(value) => handleRoleChange(member.id, value, member.full_name || 'Unknown User')}>
                                 <SelectTrigger className="w-32 h-7 text-xs">
                                   <SelectValue />
                                 </SelectTrigger>
                                 <SelectContent>
                                   <SelectItem value="user">User</SelectItem>
                                   <SelectItem value="contributor">Contributor</SelectItem>
                                   <SelectItem value="leadership">Leadership</SelectItem>
                                   <SelectItem value="admin">Admin</SelectItem>
                                   
                                 </SelectContent>
                               </Select>
                             ) : (
                               <Badge variant="outline" className="text-xs">
                                 {member.role}
                               </Badge>
                             )}
                           </div>
                         </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={member.is_active ? "default" : "secondary"}>
                            {member.is_active ? 'Enabled' : 'Disabled'}
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toggleMemberStatus(member.id, member.is_active)}
                            disabled={updatingMemberId === member.id}
                            className="text-xs"
                          >
                            {updatingMemberId === member.id ? (
                              <>Updating...</>
                            ) : member.is_active ? (
                              <>
                                <ToggleLeft className="w-4 h-4 mr-1" />
                                Disable
                              </>
                            ) : (
                              <>
                                <ToggleRight className="w-4 h-4 mr-1" />
                                Enable
                              </>
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRemoveMember(member.id, member.full_name || 'Unknown User')}
                            className="text-xs text-destructive hover:text-destructive"
                          >
                            <UserX className="w-4 h-4 mr-1" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pending Invitations */}
              {pendingMembers.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Send className="w-5 h-5" />
                    <h3 className="text-lg font-semibold">Pending Invitations ({pendingMembers.length})</h3>
                  </div>
                  
                  <div className="space-y-2">
                    {pendingMembers.map((member) => (
                       <div key={member.id} className="flex items-center justify-between p-3 border rounded-lg bg-yellow-50 dark:bg-yellow-900/20">
                         <div className="flex-1">
                           <EditableMemberName 
                             memberId={member.id}
                             currentName={member.full_name}
                             email={member.auth_data?.email || 'No email available'}
                             onNameUpdated={refetchMembers}
                           />
                          <div className="text-sm text-muted-foreground capitalize">
                            {member.role} • Invitation pending
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200">
                            Pending
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRevokePendingMember(member.id)}
                            className="text-xs text-destructive hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4 mr-1" />
                            Revoke
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

        </>
      )}
    </div>
  );
};

export default Organization;