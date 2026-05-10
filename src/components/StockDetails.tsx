import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { CombinedAsset } from "@/hooks/useCombinedAssets";
import { InventoryHistoryDialog } from "@/components/InventoryHistoryDialog";
import { ExperienceCreationDialog } from "@/components/ExperienceCreationDialog";
import { useState } from "react";
import { getThumbnailUrl } from '@/lib/imageUtils';

interface StockDetailsProps {
  stock: CombinedAsset;
  onBack: () => void;
  onRefresh?: () => void;
}

export const StockDetails = ({
  stock,
  onBack,
}: StockDetailsProps) => {
  const [isExperienceDialogOpen, setIsExperienceDialogOpen] = useState(false);
  
  const getStockStatusBadge = () => {
    if (stock.current_quantity === 0) {
      return <Badge variant="destructive">Out of Stock</Badge>;
    }
    if (stock.current_quantity <= (stock.minimum_quantity || 0)) {
      return <Badge variant="outline">Low Stock</Badge>;
    }
    return <Badge variant="default">In Stock</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Assets
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{stock.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            {getStockStatusBadge()}
            <Badge variant="secondary">Stock Item</Badge>
          </div>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => setIsExperienceDialogOpen(true)}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Experience
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Tabs defaultValue="details" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            
            <TabsContent value="details" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Stock Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <span className="font-medium">Category:</span> {stock.category || 'Uncategorized'}
                  </div>
                  <div>
                    <span className="font-medium">Description:</span> {stock.description || 'No description'}
                  </div>
                  <div>
                    <span className="font-medium">Current Quantity:</span> {stock.current_quantity} {stock.unit || 'pieces'}
                  </div>
                  <div>
                    <span className="font-medium">Minimum Quantity:</span> {stock.minimum_quantity || 0} {stock.unit || 'pieces'}
                  </div>
                  {stock.cost_per_unit && (
                    <div>
                      <span className="font-medium">Cost per Unit:</span> ${stock.cost_per_unit}
                    </div>
                  )}
                  {stock.supplier && (
                    <div>
                      <span className="font-medium">Supplier:</span> {stock.supplier}
                    </div>
                  )}
                  {stock.storage_vicinity && (
                    <div>
                      <span className="font-medium">Storage Vicinity:</span> {stock.storage_vicinity}
                    </div>
                  )}
                  {stock.storage_location && (
                    <div>
                      <span className="font-medium">Storage Location:</span> {stock.storage_location}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <InventoryHistoryDialog partId={stock.id} partName={stock.name}>
                <Button variant="outline" className="w-full">
                  View Complete History
                </Button>
              </InventoryHistoryDialog>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-6">
          {stock.image_url && (
            <Card>
              <CardContent className="p-4">
                <img
                  src={getThumbnailUrl(stock.image_url) || ''}
                  alt={stock.name}
                  className="w-full h-64 object-cover rounded-md"
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <ExperienceCreationDialog
        open={isExperienceDialogOpen}
        onOpenChange={setIsExperienceDialogOpen}
        entityType="part"
        entityId={stock.id}
        entityName={stock.name}
      />
    </div>
  );
};
