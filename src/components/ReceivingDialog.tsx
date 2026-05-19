import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Package, Calendar, Building2, Minus, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useCognitoAuth";
import { apiService } from "@/lib/apiService";
import { useOrganizationId } from "@/hooks/useOrganizationId";

interface PendingOrder {
  id: string;
  part_id: string;
  quantity_ordered: number;
  quantity_received: number;
  supplier_name?: string;
  expected_delivery_date?: string;
  estimated_cost?: number;
  notes?: string;
  order_details?: string;
  supplier_contact_info?: any;
}

interface Part {
  id: string;
  name: string;
  unit: string;
  current_quantity: number;
}

interface ReceivingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  order: PendingOrder | null;
  part: Part | null;
  onSuccess: () => void;
}

export function ReceivingDialog({ 
  isOpen, 
  onClose, 
  order, 
  part, 
  onSuccess 
}: ReceivingDialogProps) {
  const organizationId = useOrganizationId();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { user } = useAuth();
  const [receivingNotes, setReceivingNotes] = useState("");
  const [actualQuantity, setActualQuantity] = useState<number | ''>('');
  const { toast } = useToast();

  // Initialize actual quantity to expected if not set
  React.useEffect(() => {
    if (actualQuantity === '' && isOpen && order && part) {
      const quantityToReceive = order.quantity_ordered - order.quantity_received;
      setActualQuantity(quantityToReceive);
    }
  }, [order, part, actualQuantity, isOpen]);

  // Auto-populate receiving notes with order information
  React.useEffect(() => {
    if (isOpen && order) {
      const noteParts = [];
      
      // Add order details if available
      if (order.order_details && order.order_details.trim()) {
        noteParts.push(`Order Details: ${order.order_details}`);
      }
      
      // Add all URLs from supplier contact_info if available
      if (order.supplier_contact_info && order.supplier_contact_info.urls && order.supplier_contact_info.urls.length > 0) {
        const urls = order.supplier_contact_info.urls.join('\n');
        noteParts.push(`URLs:\n${urls}`);
      }
      
      // Combine all parts and add space for additional notes
      if (noteParts.length > 0) {
        const autoPopulatedNotes = noteParts.join('\n\n') + '\n\nAdditional Notes:\n';
        setReceivingNotes(autoPopulatedNotes);
      }
    } else if (!isOpen) {
      // Clear notes when dialog closes
      setReceivingNotes("");
    }
  }, [isOpen, order]);

  if (!order || !part) return null;

  const quantityToReceive = order.quantity_ordered - order.quantity_received;

  const hasMismatch = actualQuantity !== quantityToReceive;

  const handleReceive = async () => {
    if (!order || !part || actualQuantity === '') return;
    
    setIsSubmitting(true);
    
    try {
      if (!user) {
        throw new Error("Must be logged in to receive orders");
      }

      const receivedQty = typeof actualQuantity === 'number' ? actualQuantity : 0;
      
      // Determine final status based on quantity received
      let finalStatus = 'completed';
      if (receivedQty === 0) {
        finalStatus = 'problem_reported';
      } else if (receivedQty < order.quantity_ordered) {
        finalStatus = 'partially_received';
      }

      // Update the order status and quantity received
      await apiService.put(`/api/parts_orders/${order.id}`, {
        quantity_received: order.quantity_received + receivedQty,
        status: finalStatus,
        updated_at: new Date().toISOString()
      });

      // Update the part's current quantity and cost (only if quantity > 0)
      if (receivedQty > 0) {
        const updateData: any = {
          current_quantity: part.current_quantity + receivedQty,
          updated_at: new Date().toISOString()
        };

        // Update cost per unit if order has estimated cost
        if (order.estimated_cost && order.estimated_cost > 0 && receivedQty > 0) {
          updateData.cost_per_unit = order.estimated_cost / receivedQty;
        }

        await apiService.put(`/api/parts/${part.id}`, updateData);

        // Log the change to parts history
        await apiService.post('/api/parts_history', {
          part_id: part.id,
          old_quantity: part.current_quantity,
          new_quantity: part.current_quantity + receivedQty,
          quantity_change: receivedQty,
          change_type: 'quantity_add',
          change_reason: `Order received: ${order.supplier_name || 'Unknown supplier'}`,
          changed_by: user.userId,
          order_id: order.id,
          supplier_name: order.supplier_name,
        });
      }

      toast({
        title: "Order Processed",
        description: `Successfully received ${receivedQty} ${part.unit} of ${part.name}`,
      });

      onSuccess();
      onClose();
      setReceivingNotes("");
      setActualQuantity('');
      
    } catch (error) {
      console.error('Error receiving order:', error);
      toast({
        title: "Error",
        description: "Failed to receive order. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReportIssue = () => {
    // Issue system removed - show toast instead
    toast({
      title: "Note quantity mismatch",
      description: "Please add a note in the receiving notes field describing the discrepancy.",
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" />
            Receive Order
          </DialogTitle>
          <DialogDescription>
            Confirm receipt of this inventory order
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Item</Label>
              <p className="text-sm font-semibold">{part.name}</p>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Expected Quantity</Label>
              <div className="flex items-center gap-1">
                <Minus className="h-3 w-3 text-muted-foreground" />
                <p className="text-sm font-semibold">{quantityToReceive} {part.unit}</p>
              </div>
            </div>
          </div>

          <div>
            <Label htmlFor="actual-quantity" className="text-sm font-medium">
              Actual Quantity Received *
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="actual-quantity"
                type="number"
                min="0"
                placeholder="0"
                value={actualQuantity}
                onChange={(e) => setActualQuantity(e.target.value === '' ? '' : Number(e.target.value))}
                className={hasMismatch ? 'border-orange-500 focus:border-orange-500' : ''}
              />
              <span className="text-sm text-muted-foreground">{part.unit}</span>
            </div>
            {hasMismatch && (
              <div className="flex items-center gap-1 mt-1">
                <AlertTriangle className="h-3 w-3 text-orange-500" />
                <p className="text-xs text-orange-600">
                  Quantity mismatch detected - consider reporting an issue
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Supplier</Label>
              <div className="flex items-center gap-1">
                <Building2 className="h-3 w-3 text-muted-foreground" />
                <p className="text-sm">{order.supplier_name || 'Not specified'}</p>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Expected Date</Label>
              <div className="flex items-center gap-1">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <p className="text-sm">
                  {order.expected_delivery_date 
                    ? new Date(order.expected_delivery_date).toLocaleDateString()
                    : 'Not specified'
                  }
                </p>
              </div>
            </div>
          </div>

          {order.estimated_cost && order.estimated_cost > 0 && actualQuantity && actualQuantity > 0 && (
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Cost per Unit (calculated)</Label>
              <p className="text-sm">₱{(order.estimated_cost / (typeof actualQuantity === 'number' ? actualQuantity : 1)).toFixed(2)}</p>
            </div>
          )}

          <div>
            <Label htmlFor="receiving-notes" className="text-sm font-medium">
              Receiving Notes
            </Label>
            <Textarea
              id="receiving-notes"
              placeholder="Add any notes about the condition or details of received items..."
              value={receivingNotes}
              onChange={(e) => setReceivingNotes(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button 
            variant="outline"
            onClick={handleReportIssue}
            disabled={isSubmitting}
            className="border-orange-500 text-orange-600 hover:bg-orange-50"
          >
            <AlertTriangle className="h-4 w-4 mr-2" />
            Report Issue
          </Button>
          <Button 
            onClick={handleReceive} 
            disabled={isSubmitting || actualQuantity === ''}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {isSubmitting ? "Processing..." : "Receive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}