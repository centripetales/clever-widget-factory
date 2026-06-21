import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Building2, Loader2, Plus, Search, Trash2, Users, Edit, Eye } from 'lucide-react';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useSuperAdmin } from '@/hooks/useSuperAdmin';
import { useOrganization } from '@/hooks/useOrganization';
import { useToast } from '@/hooks/use-toast';
import { apiService, getApiData } from '@/lib/apiService';
import { organizationsQueryKey } from '@/lib/queryKeys';

interface Organization {
  id: string;
  name: string;
  subdomain: string | null;
  settings: any;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

interface ImpactData {
  members: number;
  actions: number;
  missions: number;
  tools: number;
  issues: number;
}

const AdminOrganizations = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isSuperAdmin, loading: superAdminLoading } = useSuperAdmin();
  const { switchOrganization } = useOrganization();
  const { organizations = [], getOrganizationWithMembers, createOrganization, updateOrganization, loading } = useOrganizations();
  const { toast } = useToast();

  const [searchTerm, setSearchTerm] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [viewMembersDialogOpen, setViewMembersDialogOpen] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [orgMembers, setOrgMembers] = useState<any[]>([]);

  // Create form state
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgSubdomain, setNewOrgSubdomain] = useState('');

  // Soft-delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Organization | null>(null);
  const [impactData, setImpactData] = useState<ImpactData | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Edit form state
  const [editOrgName, setEditOrgName] = useState('');
  const [editOrgSubdomain, setEditOrgSubdomain] = useState('');
  const [editOrgActive, setEditOrgActive] = useState(true);

  const handleCreateOrganization = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newOrgName.trim()) {
      toast({
        title: "Error",
        description: "Organization name is required",
        variant: "destructive",
      });
      return;
    }

    setCreateDialogOpen(false);
    const orgName = newOrgName.trim();
    const orgSubdomain = newOrgSubdomain.trim() || undefined;
    setNewOrgName('');
    setNewOrgSubdomain('');

    await createOrganization(orgName, orgSubdomain);
  };

  const openDeleteDialog = async (org: Organization) => {
    setDeleteTarget(org);
    setImpactData(null);
    setDeleteDialogOpen(true);
    setImpactLoading(true);
    try {
      const response = await apiService.get(`/api/organizations/${org.id}/impact`);
      setImpactData(getApiData(response));
    } catch (err) {
      console.error('Failed to fetch impact:', err);
      toast({ title: 'Error', description: 'Could not load impact data', variant: 'destructive' });
      setDeleteDialogOpen(false);
    } finally {
      setImpactLoading(false);
    }
  };

  const handleSoftDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await apiService.delete(`/api/organizations/${deleteTarget.id}`);
      toast({ title: 'Soft-deleted', description: `"${deleteTarget.name}" has been removed.` });
      // Refresh the org list
      queryClient.invalidateQueries({ queryKey: organizationsQueryKey() });
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    } catch (err) {
      console.error('Soft-delete failed:', err);
      toast({ title: 'Error', description: 'Soft-delete failed. Check console.', variant: 'destructive' });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleEditOrganization = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedOrg || !editOrgName.trim()) {
      return;
    }

    setEditDialogOpen(false);
    const orgId = selectedOrg.id;
    const orgUpdates = {
      name: editOrgName.trim(),
      subdomain: editOrgSubdomain.trim() || null,
      is_active: editOrgActive,
    };
    setSelectedOrg(null);

    await updateOrganization(orgId, orgUpdates);
  };

  const openEditDialog = (org: Organization) => {
    setSelectedOrg(org);
    setEditOrgName(org.name);
    setEditOrgSubdomain(org.subdomain || '');
    setEditOrgActive(org.is_active);
    setEditDialogOpen(true);
  };

  const openViewMembersDialog = async (org: Organization) => {
    setSelectedOrg(org);
    const orgWithMembers = await getOrganizationWithMembers(org.id);
    setOrgMembers(orgWithMembers?.organization_members || []);
    setViewMembersDialogOpen(true);
  };

  const filteredOrganizations = organizations.filter(org =>
    org.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (org.subdomain && org.subdomain.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  if (superAdminLoading) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-6">
            <p>Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-center text-muted-foreground">Access denied. Super admin privileges required.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Organization Management</h1>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Create Organization
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Organization</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateOrganization} className="space-y-4">
              <div>
                <Label htmlFor="org-name">Organization Name</Label>
                <Input
                  id="org-name"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="Enter organization name"
                  required
                />
              </div>
              <div>
                <Label htmlFor="org-subdomain">Subdomain (optional)</Label>
                <Input
                  id="org-subdomain"
                  value={newOrgSubdomain}
                  onChange={(e) => setNewOrgSubdomain(e.target.value)}
                  placeholder="organization-slug"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? 'Creating...' : 'Create'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search organizations..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Organizations List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            Organizations ({filteredOrganizations.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredOrganizations.length === 0 ? (
            <p className="text-center text-muted-foreground py-4">
              {searchTerm ? 'No organizations match your search' : 'No organizations found'}
            </p>
          ) : (
            <div className="space-y-3">
              {filteredOrganizations.map((org) => (
                <div
                  key={org.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => switchOrganization(org.id)}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold">{org.name}</h3>
                      <Badge variant={org.is_active ? "default" : "destructive"}>
                        {org.is_active ? "Active" : "Inactive"}
                      </Badge>
                      {org.subdomain && (
                        <Badge variant="outline">{org.subdomain}</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {org.member_count || 0} members
                      </span>
                      <span>Created: {new Date(org.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        openViewMembersDialog(org);
                      }}
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditDialog(org);
                      }}
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    {!org.is_active && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:bg-destructive hover:text-destructive-foreground border-destructive/40"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDeleteDialog(org);
                        }}
                        title="Soft-delete this inactive organization"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Organization Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Organization</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditOrganization} className="space-y-4">
            <div>
              <Label htmlFor="edit-org-name">Organization Name</Label>
              <Input
                id="edit-org-name"
                value={editOrgName}
                onChange={(e) => setEditOrgName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="edit-org-subdomain">Subdomain</Label>
              <Input
                id="edit-org-subdomain"
                value={editOrgSubdomain}
                onChange={(e) => setEditOrgSubdomain(e.target.value)}
                placeholder="organization-slug"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Switch
                id="edit-org-active"
                checked={editOrgActive}
                onCheckedChange={setEditOrgActive}
              />
              <Label htmlFor="edit-org-active">Active</Label>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Updating...' : 'Update'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Soft-Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Soft-Delete Organization
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This will mark <span className="font-semibold text-foreground">{deleteTarget?.name}</span> as
              inactive. No data will be permanently removed.
            </p>

            {impactLoading ? (
              <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading impact data…</span>
              </div>
            ) : impactData ? (
              <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">Direct dependents</p>
                {Object.entries(impactData).map(([key, count]) => (
                  <div key={key} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{key}</span>
                    <Badge variant={count > 0 ? 'destructive' : 'secondary'}>{count}</Badge>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleteLoading}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleSoftDelete}
                disabled={deleteLoading || impactLoading}
              >
                {deleteLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Deleting…</> : 'Confirm Soft-Delete'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Members Dialog */}
      <Dialog open={viewMembersDialogOpen} onOpenChange={setViewMembersDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selectedOrg?.name} - Members
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {orgMembers.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">
                No members found
              </p>
            ) : (
              orgMembers.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium">
                        {member.profiles?.full_name || 'Unknown User'}
                      </span>
                      <Badge variant="outline">{member.role}</Badge>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminOrganizations;