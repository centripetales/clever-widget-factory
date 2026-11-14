import { Database } from '@/integrations/supabase/types';

// Issue type options - centralized for consistency across the app  
export const ISSUE_TYPE_OPTIONS = [
  { value: 'safety' as const, label: 'Safety' },
  { value: 'efficiency' as const, label: 'Efficiency' },
  { value: 'cosmetic' as const, label: 'Cosmetic' },
  { value: 'preventative_maintenance' as const, label: 'Preventative Maintenance' },
  { value: 'functionality' as const, label: 'Functionality' }
] as const;

// Action required options for workflow
export const ACTION_REQUIRED_OPTIONS = [
  { value: 'repair' as const, label: 'Repair' },
  { value: 'replace_part' as const, label: 'Replace Part' },
  { value: 'not_fixable' as const, label: 'Damaged - Not Fixable' },
  { value: 'remove' as const, label: 'Remove from Service' }
] as const;

// Workflow status options
export const WORKFLOW_STATUS_OPTIONS = [
  { value: 'reported' as const, label: 'Reported' },
  { value: 'diagnosed' as const, label: 'Diagnosed' },
  { value: 'in_progress' as const, label: 'In Progress' },
  { value: 'completed' as const, label: 'Completed' }
] as const;

// Tool condition options - simplified binary system
export const TOOL_CONDITION_OPTIONS = [
  { value: 'no_problems_observed' as const, label: 'No problems detected' },
  { value: 'functional_but_not_efficient' as const, label: 'Functional but not efficient' },
  { value: 'not_functional' as const, label: 'Not functional' }
] as const;

// Tool status utility functions
export const getStatusColor = (status: string) => {
  switch (status) {
    case 'available': return 'bg-green-100 text-green-800';
    case 'checked_out': return 'bg-yellow-100 text-yellow-800';
    case 'removed': return 'bg-gray-100 text-gray-800';
    case 'concluded': return 'bg-emerald-50 text-emerald-800';
    default: return 'bg-gray-100 text-gray-800';
  }
};

export const getStatusLabel = (status: string) => {
  switch (status) {
    case 'available': return 'Available';
    case 'checked_out': return 'Checked Out';
    case 'removed': return 'Removed';
    case 'concluded': return 'Concluded';
    default: return status;
  }
};

// Tool category options
export const TOOL_CATEGORY_OPTIONS = [
  { value: 'Hand Tools', label: 'Hand Tools' },
  { value: 'Electric Tool', label: 'Electric Tool' },
  { value: 'Other', label: 'Other' },
  { value: 'Container', label: 'Container' },
  { value: 'Infrastructure', label: 'Infrastructure' },
  { value: 'Biological', label: 'Biological' },
  { value: 'Field', label: 'Field'},
  { value: 'System', label: 'System' }
] as const;


// Default done definition for tasks only
export const DEFAULT_DONE_DEFINITION = "The task is complete when the images show the full solution, work follows Stargazer SOP, reflects best practices and professionalism, and any problems encountered are documented.";