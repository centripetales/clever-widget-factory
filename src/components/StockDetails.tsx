import { ArrowLeft, Plus, MapPin, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { CombinedAsset } from "@/hooks/useCombinedAssets";
import { InventoryHistoryContent } from "@/components/InventoryHistoryContent";
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
        {stock.image_url && (
          <img
            src={getThumbnailUrl(stock.image_url) || ''}
            alt={stock.name}
            className="w-12 h-12 object-cover rounded-md flex-shrink-0"
          />
        )}
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

      <div className="grid grid-cols-1 gap-6">
        <div>
          <Tabs defaultValue="history" className="w-full">
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

              {stock.gps_latitude && stock.gps_longitude && (
                <Card className="relative group overflow-hidden">
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button
                        size="icon"
                        variant="secondary"
                        className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-[90vw] w-[90vw] h-[90vh] p-0 border-none bg-transparent overflow-hidden">
                      <iframe 
                        width="100%" 
                        height="100%" 
                        frameBorder="0" 
                        style={{ border: 0, borderRadius: 'var(--radius)' }}
                        src={`https://maps.google.com/maps?q=${stock.gps_latitude},${stock.gps_longitude}&hl=en&z=17&t=k&output=embed`}
                        allowFullScreen
                      ></iframe>
                    </DialogContent>
                  </Dialog>
                  <CardContent className="p-0 h-64">
                    <iframe 
                      width="100%" 
                      height="100%" 
                      frameBorder="0" 
                      style={{ border: 0 }}
                      src={`https://maps.google.com/maps?q=${stock.gps_latitude},${stock.gps_longitude}&hl=en&z=17&t=k&output=embed`}
                      allowFullScreen
                    ></iframe>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <InventoryHistoryContent partId={stock.id} />
            </TabsContent>
          </Tabs>
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
