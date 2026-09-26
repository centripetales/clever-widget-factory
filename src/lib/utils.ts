import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { supabase } from '@/lib/client';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Determines if a hex color is light or dark for text contrast
 * Returns true if the color is light (use dark text), false if dark (use light text)
 */
export function isLightColor(hex: string): boolean {
  if (!hex || hex === '#6B7280') return false; // Default gray is dark
  
  // Remove # if present
  const color = hex.replace('#', '');
  
  // Convert to RGB
  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);
  
  // Calculate relative luminance using WCAG formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  
  // Return true if light (luminance > 0.5), false if dark
  return luminance > 0.5;
}

export function sanitizeRichText(text?: string | null): string | null {
  if (!text) return null;
  
  // Try to use DOMParser for better HTML parsing (client-side)
  let strippedText: string;
  if (typeof window !== 'undefined' && window.DOMParser) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');
      strippedText = doc.body.textContent || doc.body.innerText || '';
    } catch {
      // Fallback to regex if DOMParser fails
      strippedText = text.replace(/<[^>]*>/g, '');
    }
  } else {
    // Server-side or fallback: use regex
    strippedText = text.replace(/<[^>]*>/g, '');
  }
  
  // Clean up various whitespace and entities
  strippedText = strippedText
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-zA-Z0-9#]+;/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width spaces
    .trim();
  
  return strippedText.length > 0 ? text : null;
}

export function hasActualContent(text?: string | null): boolean {
  return sanitizeRichText(text) !== null;
}

export interface ActionBorderStyle {
  bgColor: string;
  borderColor: string;
  textColor: string;
}

/**
 * Get consistent border styling for actions based on their state
 * Progression: Gray (no border) → Blue (plan + commitment) → Yellow (implementation) → Green (completed)
 * Yellow can only occur if there was first a plan (blue state)
 * 
 * @param action - The action object with status, policy, etc.
 * @param derivedCount - Optional observation count derived from TanStack cache (preferred over action.has_implementation_updates)
 */
export function getActionBorderStyle(
  action: {
    status: string;
    title?: string;
    policy?: string | null;
    assigned_to?: string | null;
    policy_agreed_at?: string | null;
    policy_agreed_by?: string | null;
    plan_commitment?: boolean;
    has_implementation_updates?: boolean;
  },
  derivedCount?: number
): ActionBorderStyle {
  const hasPolicy = hasActualContent(action.policy);
  
  // Prefer derived count from cache, then fall back to has_implementation_updates boolean from API
  // If derivedCount is provided (even if 0), use it. Otherwise use has_implementation_updates flag
  const hasImplementationUpdates = derivedCount !== undefined 
    ? derivedCount > 0 
    : (action.has_implementation_updates ?? false);
  
  const isAssigned = Boolean(action.assigned_to);
  const hasPolicyAgreement = Boolean(action.policy_agreed_at || action.plan_commitment);

  // Green border for completed actions
  if (action.status === 'completed') {
    return {
      bgColor: '',
      borderColor: 'border-emerald-500 border-2 shadow-emerald-200 shadow-lg dark:border-emerald-600 dark:shadow-emerald-900',
      textColor: ''
    };
  }
  
  // Yellow border when there are implementation updates AND there was first a policy agreement
  // This ensures proper progression: Gray → Blue → Yellow → Green
  if (hasImplementationUpdates && hasPolicy && hasPolicyAgreement) {
    return {
      bgColor: 'bg-background',
      borderColor: 'border-yellow-500 border-2 shadow-yellow-200 shadow-lg dark:border-yellow-600 dark:shadow-yellow-900',
      textColor: 'text-foreground'
    };
  }
  
  // Blue border when there's a policy AND plan commitment (ready to work)
  if (hasPolicy && hasPolicyAgreement) {
    return {
      bgColor: '',
      borderColor: 'border-blue-500 border-2 shadow-blue-200 shadow-lg dark:border-blue-600 dark:shadow-blue-900',
      textColor: ''
    };
  }
  
  // Default styling (gray - no border) - initial state
  return {
    bgColor: '',
    borderColor: '',
    textColor: ''
  };
}

/**
 * Process stock consumption for an action when it's completed
 * This function handles decrementing stock quantities and logging usage
 */
export async function processStockConsumption(
  requiredStock: { part_id: string; quantity: number; part_name: string; }[],
  actionId: string,
  userId: string,
  actionTitle: string,
  missionId: string | undefined,
  queryClient: any // TanStack QueryClient - required, parts should already be in cache
): Promise<void> {
  if (!requiredStock || requiredStock.length === 0) {
    return; // No stock to process
  }

  // Import apiService dynamically to avoid circular dependencies
  const { apiService } = await import('./apiService');

  for (const stockItem of requiredStock) {
    try {
      // Parts should already be loaded into TanStack Query cache
      // via useCombinedAssets hook
      // If they're not in cache, that's an error condition
      const cachedParts = queryClient.getQueryData(['parts']) as any[] | undefined;
      
      if (!cachedParts || !Array.isArray(cachedParts)) {
        throw new Error(
          `Parts data not found in TanStack Query cache. ` +
          `This indicates parts haven't been loaded yet. ` +
          `Ensure useCombinedAssets is used in the component tree.`
        );
      }
      
      const partData = cachedParts.find((p: any) => p.id === stockItem.part_id);
      
      if (!partData) {
        const partName = stockItem.part_name || 'Unknown part';
        console.error(`Part not found:`, {
          part_id: stockItem.part_id,
          part_name: partName,
          quantity: stockItem.quantity,
          action_id: actionId,
          action_title: actionTitle
        });
        throw new Error(
          `Stock item "${partName}" (ID: ${stockItem.part_id}) no longer exists in inventory. ` +
          `Please remove this item from the action's required stock before completing.`
        );
      }

      const oldQuantity = partData.current_quantity || 0;
      const newQuantity = Math.max(0, oldQuantity - stockItem.quantity);
      
      // Update part quantity using apiService (includes auth token)
      await apiService.put(`/parts/${stockItem.part_id}`, {
        current_quantity: newQuantity
      });

      // Log to parts_history table using apiService (includes auth token)
      try {
        await apiService.post('/parts_history', {
          part_id: stockItem.part_id,
          change_type: stockItem.quantity < 0 ? 'quantity_add' : 'quantity_remove',
          old_quantity: oldQuantity,
          new_quantity: newQuantity,
          quantity_change: -stockItem.quantity,
          changed_by: userId,
          change_reason: stockItem.quantity < 0
            ? `Produced by action: ${actionTitle} - ${-stockItem.quantity} ${stockItem.part_name}`
            : `Used for action: ${actionTitle} - ${stockItem.quantity} ${stockItem.part_name}`,
          action_id: actionId, // Link to the action for auditability
        });
      } catch (historyError) {
        console.error('Error creating parts history:', historyError);
        // Don't throw - the main operation succeeded
      }
      queryClient.invalidateQueries({ queryKey: ['part_history', stockItem.part_id] });
    } catch (error) {
      console.error(`Error processing stock item ${stockItem.part_id}:`, error);
      throw error;
    }
  }
}

/**
 * Apply an optional stock change alongside some other record (e.g. a financial
 * transaction). Same PUT /parts + POST /parts_history mechanics as
 * processStockConsumption, but with a caller-supplied reason instead of
 * action-specific wording.
 */
export async function processStockAdjustment(
  stockChanges: { part_id: string; quantity: number; part_name: string; }[],
  userId: string,
  contextLabel: string,
  queryClient: any // TanStack QueryClient - required, parts should already be in cache
): Promise<void> {
  if (!stockChanges || stockChanges.length === 0) {
    return;
  }

  const { apiService } = await import('./apiService');

  for (const stockItem of stockChanges) {
    const cachedParts = queryClient.getQueryData(['parts']) as any[] | undefined;

    if (!cachedParts || !Array.isArray(cachedParts)) {
      throw new Error(
        `Parts data not found in TanStack Query cache. Ensure parts have been loaded before adjusting stock.`
      );
    }

    const partData = cachedParts.find((p: any) => p.id === stockItem.part_id);

    if (!partData) {
      throw new Error(
        `Stock item "${stockItem.part_name || 'Unknown part'}" (ID: ${stockItem.part_id}) no longer exists in inventory.`
      );
    }

    const oldQuantity = partData.current_quantity || 0;
    const newQuantity = Math.max(0, oldQuantity - stockItem.quantity);

    await apiService.put(`/parts/${stockItem.part_id}`, {
      current_quantity: newQuantity
    });

    try {
      await apiService.post('/parts_history', {
        part_id: stockItem.part_id,
        change_type: stockItem.quantity < 0 ? 'quantity_add' : 'quantity_remove',
        old_quantity: oldQuantity,
        new_quantity: newQuantity,
        quantity_change: -stockItem.quantity,
        changed_by: userId,
        change_reason: stockItem.quantity < 0
          ? `Added via ${contextLabel} - ${-stockItem.quantity} ${stockItem.part_name}`
          : `Removed via ${contextLabel} - ${stockItem.quantity} ${stockItem.part_name}`,
      });
    } catch (historyError) {
      console.error('Error creating parts history:', historyError);
    }
    queryClient.invalidateQueries({ queryKey: ['part_history', stockItem.part_id] });
    queryClient.invalidateQueries({ queryKey: ['parts'] });
  }
}
