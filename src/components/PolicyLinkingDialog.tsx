/**
 * PolicyLinkingDialog Component
 * 
 * Dialog for linking explorations to existing policies
 * Includes policy search and selection functionality
 * 
 * Requirements: 3.5, 7.3
 */

import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useQuery } from '@tanstack/react-query';
import { Search, Link, X, Loader2, FileText, Calendar } from 'lucide-react';
import { PolicyService, PolicyResponse } from '@/services/policyService';
import { ActionService } from '@/services/actionService';
import { ExplorationListItem } from '@/services/explorationService';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { format } from 'date-fns';

interface PolicyLinkingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exploration: ExplorationListItem | null;
  onPolicyLinked?: (policyId: number) => void;
}

export function PolicyLinkingDialog({
  open,
  onOpenChange,
  exploration,
  onPolicyLinked
}: PolicyLinkingDialogProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedPolicy, setSelectedPolicy] = useState<PolicyResponse | null>(null);
  const [isLinking, setIsLinking] = useState(false);

  const { toast } = useToast();
  const policyService = new PolicyService();
  const actionService = new ActionService();

  // Fetch policies
  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['policies', statusFilter],
    queryFn: async () => {
      const filters: any = {};
      if (statusFilter !== 'all') {
        filters.status = statusFilter;
      }
      return policyService.listPolicies(filters);
    },
    enabled: open,
    ...offlineQueryConfig,
  });

  // Filter policies by search term
  const filteredPolicies = useMemo(() => {
    if (!searchTerm) return policies;
    
    const searchLower = searchTerm.toLowerCase();
    return policies.filter(policy => 
      policy.title.toLowerCase().includes(searchLower) ||
      policy.description_text.toLowerCase().includes(searchLower) ||
      policy.category?.toLowerCase().includes(searchLower)
    );
  }, [policies, searchTerm]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSearchTerm('');
      setStatusFilter('all');
      setSelectedPolicy(null);
    }
  }, [open]);

  const handleLinkPolicy = async () => {
    if (!selectedPolicy || !exploration) return;

    try {
      setIsLinking(true);

      // Update the action to link it to the selected policy
      await actionService.updateAction(exploration.action_id, {
        policy_id: selectedPolicy.id
      });

      toast({
        title: "Success",
        description: `Action linked to policy "${selectedPolicy.title}"`,
      });

      onPolicyLinked?.(selectedPolicy.id);
      onOpenChange(false);
    } catch (error) {
      console.error('Error linking policy:', error);
      toast({
        title: "Error",
        description: "Failed to link policy to action",
        variant: "destructive",
      });
    } finally {
      setIsLinking(false);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  if (!exploration) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link to Existing Policy</DialogTitle>
          <DialogDescription>
            Link exploration {exploration.exploration_code} to an existing policy
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Exploration Context */}
          <div className="bg-muted/50 p-4 rounded-lg space-y-2">
            <h4 className="font-medium">Exploration Context</h4>
            <div className="text-sm space-y-1">
              <p><strong>Code:</strong> {exploration.exploration_code}</p>
              <p><strong>State:</strong> {exploration.state_text}</p>
              {exploration.summary_policy_text && (
                <p><strong>Summary Plan:</strong> {exploration.summary_policy_text.substring(0, 200)}...</p>
              )}
            </div>
          </div>

          {/* Search and Filters */}
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Search */}
              <div className="space-y-2">
                <Label htmlFor="search">Search Policies</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="search"
                    placeholder="Search by title, description, or category..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              {/* Status Filter */}
              <div className="space-y-2">
                <Label htmlFor="status">Status Filter</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="deprecated">Deprecated</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Policy List */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Available Policies ({filteredPolicies.length})</h4>
              {selectedPolicy && (
                <Badge variant="secondary">
                  Selected: {selectedPolicy.title}
                </Badge>
              )}
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span>Loading policies...</span>
              </div>
            ) : filteredPolicies.length === 0 ? (
              <div className="text-center py-8">
                <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No policies found</h3>
                <p className="text-muted-foreground">
                  {policies.length === 0 
                    ? "No policies have been created yet."
                    : "No policies match your current search and filters."
                  }
                </p>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto space-y-3">
                {filteredPolicies.map((policy) => (
                  <PolicyCard
                    key={policy.id}
                    policy={policy}
                    isSelected={selectedPolicy?.id === policy.id}
                    onSelect={() => setSelectedPolicy(policy)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isLinking}
            >
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleLinkPolicy}
              disabled={isLinking || !selectedPolicy}
            >
              {isLinking ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Link className="h-4 w-4 mr-2" />
              )}
              {isLinking ? 'Linking...' : 'Link Policy'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Policy Card Component
interface PolicyCardProps {
  policy: PolicyResponse;
  isSelected: boolean;
  onSelect: () => void;
}

function PolicyCard({ policy, isSelected, onSelect }: PolicyCardProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 text-green-800';
      case 'deprecated':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getPriorityColor = (priority?: string) => {
    switch (priority) {
      case 'high':
        return 'bg-red-100 text-red-800';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800';
      case 'low':
        return 'bg-green-100 text-green-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <Card 
      className={`cursor-pointer transition-all hover:shadow-md ${
        isSelected ? 'ring-2 ring-primary bg-primary/5' : ''
      }`}
      onClick={onSelect}
    >
      <CardContent className="p-4">
        <div className="space-y-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 flex-1">
              <h4 className="font-semibold line-clamp-1">{policy.title}</h4>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={getStatusColor(policy.status)}>
                  {policy.status}
                </Badge>
                {policy.priority && (
                  <Badge variant="outline" className={getPriorityColor(policy.priority)}>
                    {policy.priority} priority
                  </Badge>
                )}
                {policy.category && (
                  <Badge variant="outline">
                    {policy.category}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* Description */}
          <p className="text-sm text-muted-foreground line-clamp-2">
            {policy.description_text}
          </p>

          {/* Metadata */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              <span>Created {format(new Date(policy.created_at), 'MMM dd, yyyy')}</span>
            </div>
            {policy.effective_start_date && (
              <div className="flex items-center gap-1">
                <span>Effective {format(new Date(policy.effective_start_date), 'MMM dd, yyyy')}</span>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}