import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Wrench, Edit, Trash2, AlertTriangle, AlertCircle, Plus, Minus, History, Triangle, Info, ExternalLink, Camera, MapPin, Handshake, Network } from "lucide-react";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { InventoryHistoryDialog } from "./InventoryHistoryDialog";
import { AssetHistoryDialog } from "./AssetHistoryDialog";
import { ShareConfigurationDialog } from "./ShareConfigurationDialog";
import { Link } from "react-router-dom";
import { getThumbnailUrl } from '@/lib/imageUtils';
import { PrismIcon } from "@/components/icons/PrismIcon";

import { useMemo, memo, useState } from "react";

import { CombinedAsset } from '@/hooks/useCombinedAssets';
import { useToast } from "@/hooks/use-toast";

interface CheckoutInfo {
  user_name: string;
  user_id: string;
  checkout_date?: string;
}

interface CombinedAssetCardProps {
  asset: CombinedAsset;
  canEdit: boolean;
  isAdmin: boolean;
  currentUserId?: string;
  currentUserEmail?: string;
  checkoutInfo?: CheckoutInfo;
  onView: (asset: CombinedAsset) => void;
  onEdit: (asset: CombinedAsset) => void;
  onRemove: (asset: CombinedAsset) => void;
  onAddQuantity?: (asset: CombinedAsset) => void;
  onUseQuantity?: (asset: CombinedAsset) => void;
  onAskMaxwell?: (asset: CombinedAsset) => void;
  onAddObservation?: (asset: CombinedAsset) => void;
  itemCount?: number;
}

// Custom comparison function for memo to prevent unnecessary re-renders
const arePropsEqual = (prevProps: CombinedAssetCardProps, nextProps: CombinedAssetCardProps) => {
  // Compare primitive props
  if (prevProps.canEdit !== nextProps.canEdit ||
    prevProps.isAdmin !== nextProps.isAdmin ||
    prevProps.currentUserId !== nextProps.currentUserId ||
    prevProps.currentUserEmail !== nextProps.currentUserEmail ||
    prevProps.itemCount !== nextProps.itemCount ||
    prevProps.checkoutInfo?.user_id !== nextProps.checkoutInfo?.user_id) {
    return false;
  }

  // Deep compare the asset object
  const prevAsset = prevProps.asset;
  const nextAsset = nextProps.asset;

  // Check if asset reference is the same (fast path)
  if (prevAsset === nextAsset) {
    return true;
  }

  // Check if asset ID is different (different asset)
  if (prevAsset.id !== nextAsset.id) {
    return false;
  }

  // Check key properties that are most likely to change
  const keyChanges = {
    name: prevAsset.name !== nextAsset.name,
    type: prevAsset.type !== nextAsset.type,
    status: prevAsset.status !== nextAsset.status,
    current_quantity: prevAsset.current_quantity !== nextAsset.current_quantity,
    accountable_person_name: prevAsset.accountable_person_name !== nextAsset.accountable_person_name,
    accountable_person_color: prevAsset.accountable_person_color !== nextAsset.accountable_person_color,
    updated_at: prevAsset.updated_at !== nextAsset.updated_at
  };

  const hasKeyChanges = Object.values(keyChanges).some(Boolean);
  if (hasKeyChanges) {
    return false;
  }

  // Check all other properties
  if (prevAsset.description !== nextAsset.description ||
    prevAsset.category !== nextAsset.category ||
    prevAsset.serial_number !== nextAsset.serial_number ||
    prevAsset.minimum_quantity !== nextAsset.minimum_quantity ||
    prevAsset.unit !== nextAsset.unit ||
    prevAsset.cost_per_unit !== nextAsset.cost_per_unit ||
    prevAsset.cost_evidence_url !== nextAsset.cost_evidence_url ||
    prevAsset.supplier !== nextAsset.supplier ||
    prevAsset.image_url !== nextAsset.image_url ||
    prevAsset.storage_location !== nextAsset.storage_location ||
    prevAsset.storage_vicinity !== nextAsset.storage_vicinity ||
    prevAsset.parent_structure_id !== nextAsset.parent_structure_id ||
    prevAsset.parent_structure_name !== nextAsset.parent_structure_name ||
    prevAsset.legacy_storage_vicinity !== nextAsset.legacy_storage_vicinity ||
    prevAsset.area_display !== nextAsset.area_display ||
    prevAsset.accountable_person_id !== nextAsset.accountable_person_id ||
    prevAsset.created_at !== nextAsset.created_at) {
    return false;
  }

  return true;
};

export const CombinedAssetCard = memo(({
  asset,
  canEdit,
  isAdmin,
  currentUserId,
  currentUserEmail,
  checkoutInfo,
  onView,
  onEdit,
  onRemove,
  onAddQuantity,
  onUseQuantity,
  onAskMaxwell,
  onAddObservation,
  itemCount
}: CombinedAssetCardProps) => {
  const { toast } = useToast();
  const [showShareDialog, setShowShareDialog] = useState(false);
  const checkoutDateDisplay = useMemo(() => {
    if (!checkoutInfo?.checkout_date) return null;
    const parsedDate = new Date(checkoutInfo.checkout_date);
    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }
    const datePart = parsedDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const timePart = parsedDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    return `${datePart} at ${timePart}`;
  }, [checkoutInfo?.checkout_date]);

  function getStatusBadge() {
    if (asset.type === 'asset') {
      if (asset.is_checked_out) {
        return <Badge variant="outline" className="text-orange-600 border-orange-600">Checked Out</Badge>;
      }
      if (asset.status === 'removed') {
        return <Badge variant="outline" className="text-gray-600 border-gray-600">Removed</Badge>;
      }
      return <Badge variant="outline" className="text-green-600 border-green-600">Available</Badge>;
    } else {
      const isLowStock = asset.minimum_quantity && asset.current_quantity && asset.current_quantity <= asset.minimum_quantity;
      if (isLowStock) {
        return <Badge variant="outline" className="text-red-600 border-red-600">Low Stock</Badge>;
      }
      return <Badge variant="outline" className="text-green-600 border-green-600">In Stock</Badge>;
    }
  }

  const getIconColor = () => {
    if (asset.type === 'asset') {
      return "text-blue-600";
    }
    return "text-green-600";
  };

  const statusBadge = useMemo(() => {
    return getStatusBadge();
  }, [asset.type, asset.is_checked_out, asset.status, asset.minimum_quantity, asset.current_quantity]);

  const iconColor = useMemo(() => {
    return getIconColor();
  }, [asset.type]);

  return (
    <Card className="relative hover:shadow-md transition-shadow cursor-pointer flex flex-col min-h-[280px] md:min-h-[320px]" onClick={() => onView(asset)}>
      <CardHeader className="pb-2 pt-2 flex-shrink-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg line-clamp-2 flex-1 leading-tight">
            {asset.name}
            {itemCount !== undefined && (
              <Badge variant="secondary" className="ml-2 text-xs font-normal">
                {itemCount} {itemCount === 1 ? 'item' : 'items'}
              </Badge>
            )}
            {asset.similarity_score !== undefined && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 ml-2 text-xs text-muted-foreground font-normal cursor-help">
                      <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 14 L2 14 L14 2" />
                      </svg>
                      {asset.similarity_score.toFixed(3)}
                      <Info className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="space-y-1 text-xs">
                      <p className="font-semibold">Semantic Distance: {asset.similarity_score.toFixed(3)}</p>
                      <p>Lower values = better match (0 = identical)</p>
                      <p className="text-muted-foreground">Uses Amazon Titan v1 embeddings (1536 dimensions) to convert search into a vector, then calculates cosine distance: 1 - (dot product / (||A|| × ||B||)) against Asset name and descriptions. This measures the angle between your search and this item in high-dimensional space. If getting bad results, verify name spelling is correct and there is an accurate description.</p>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </CardTitle>
          {asset.type === 'stock' && canEdit && !asset.is_shared_inbound && (
            <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              {onUseQuantity && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUseQuantity(asset);
                  }}
                >
                  <Minus className="h-3 w-3" />
                </Button>
              )}
              {onAddQuantity && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddQuantity(asset);
                  }}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              )}
            </div>
          )}
        </div>

        {(asset.type === 'asset' || asset.category || asset.is_shared_inbound) && (
          <div className="flex flex-wrap gap-1 -mt-1">
            {asset.type === 'asset' && asset.is_checked_out && statusBadge}
            {asset.category && asset.category !== 'Electric Tool' && asset.category !== 'Biological' && (
              <Badge variant="outline" className="text-xs">{asset.category}</Badge>
            )}
            {asset.is_shared_inbound && (
              <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 flex items-center gap-1">
                <Network className="h-3 w-3" />
                Shared
              </Badge>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0 pb-2 pl-3 pr-3 flex-1 flex flex-col">
        {asset.image_url && (
          <div className="mb-2 w-full h-32 md:h-40 rounded-md border bg-muted overflow-hidden flex-shrink-0">
            <img
              src={getThumbnailUrl(asset.image_url) || ''}
              alt={asset.name}
              className="w-full h-full object-cover"
              loading="lazy"
              decoding="async"
            />
          </div>
        )}

        <div className="space-y-1 text-sm text-muted-foreground">
          {asset.serial_number && (
            <div>
              <span className="font-medium">Serial:</span> {asset.serial_number}
            </div>
          )}


          {asset.type === 'stock' && (() => {
            const areaDisplay = asset.area_display || asset.parent_structure_name;
            const locationParts = [];
            if (areaDisplay) locationParts.push(areaDisplay);
            if (asset.storage_location) locationParts.push(asset.storage_location);
            const locationStr = locationParts.length > 0 ? ` at ${locationParts.join(' - ')}` : '';

            return (
              <div>
                {asset.current_quantity} {asset.unit || 'pieces'}{locationStr}
                {asset.minimum_quantity && (
                  <span className="text-xs ml-1">(min: {asset.minimum_quantity})</span>
                )}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span 
                        className={`inline-flex items-center ml-2 cursor-pointer ${asset.gps_latitude && asset.gps_longitude ? 'text-primary' : 'text-gray-300 hover:text-gray-400'}`} 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!asset.gps_latitude || !asset.gps_longitude) {
                            toast({ 
                              title: "GPS Unavailable", 
                              description: "This asset image needs gps coordinates to use this feature." 
                            });
                          }
                        }}
                      >
                        <MapPin className="h-4 w-4" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{asset.gps_latitude && asset.gps_longitude ? 'GPS coordinates available' : 'Missing GPS coordinates'}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          })()}

          {asset.type === 'asset' && (asset.area_display || asset.parent_structure_name || asset.storage_location || asset.gps_latitude || asset.gps_longitude) && (
            <div className="flex items-center">
              {[asset.area_display || asset.parent_structure_name, asset.storage_location].filter(Boolean).join(' - ')}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span 
                      className={`inline-flex items-center ml-2 cursor-pointer ${asset.gps_latitude && asset.gps_longitude ? 'text-primary' : 'text-gray-300 hover:text-gray-400'}`} 
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!asset.gps_latitude || !asset.gps_longitude) {
                          toast({ 
                            title: "GPS Unavailable", 
                            description: "This asset image needs gps coordinates to use this feature." 
                          });
                        }
                      }}
                    >
                      <MapPin className="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{asset.gps_latitude && asset.gps_longitude ? 'GPS coordinates available' : 'Missing GPS coordinates'}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {checkoutInfo && (
            <div>
              <span className="font-medium">Checked out to:</span> {checkoutInfo.user_name}
              {asset.checkout_action_id && (
                <Link
                  to={`/actions?id=${asset.checkout_action_id}`}
                  className="inline-flex items-center gap-1 ml-2 text-xs text-primary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  View Action <ExternalLink className="h-3 w-3" />
                </Link>
              )}
              <div className="text-xs text-muted-foreground mt-1">
                {checkoutDateDisplay ? `Since ${checkoutDateDisplay}` : 'Checkout date unavailable'}
              </div>
            </div>
          )}

          {asset.accountable_person_name && (
            <div>
              <span className="font-medium">Accountable:</span>
              <span style={{ color: asset.accountable_person_color || '#6B7280' }} className="ml-1">
                {asset.accountable_person_name}
              </span>
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-2 mt-auto pt-2" onClick={(e) => e.stopPropagation()}>
          {/* Asset-specific buttons */}

          {asset.type === 'asset' && (
            <>
              {onAddObservation && !asset.is_shared_inbound && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-12 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddObservation(asset);
                        }}
                      >
                        <Camera className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Add Observation</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <AssetHistoryDialog assetId={asset.id} assetName={asset.name}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-12 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                    </AssetHistoryDialog>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>View History</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              {!asset.is_shared_inbound && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={asset.is_shared_outbound ? "default" : "outline"}
                        size="sm"
                        className={`w-12 px-2 ${asset.is_shared_outbound ? "bg-green-100 text-green-600" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowShareDialog(true);
                        }}
                      >
                        <Handshake className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Share Asset</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}

{onAskMaxwell && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-12 px-2 [&_svg]:size-auto"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAskMaxwell(asset);
                        }}
                      >
                        <PrismIcon size={18} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Ask Maxwell</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </>
          )}



          {/* Stock-specific buttons */}
          {asset.type === 'stock' && canEdit && !asset.is_shared_inbound && (
            <>
              <div className="flex gap-2 flex-1">
                {onAddObservation && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-12 px-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddObservation(asset);
                          }}
                        >
                          <Camera className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Add Observation</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={asset.is_shared_outbound ? "default" : "outline"}
                        size="sm"
                        className={`w-12 px-2 ${asset.is_shared_outbound ? "bg-green-100 text-green-600" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowShareDialog(true);
                        }}
                      >
                        <Handshake className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Share Stock</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {/* Stock History Button */}
                <InventoryHistoryDialog partId={asset.id} partName={asset.name}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-12 px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    <History className="h-4 w-4" />
                  </Button>
                </InventoryHistoryDialog>

                {onAskMaxwell && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-12 px-2 [&_svg]:size-auto"
                          onClick={(e) => {
                            e.stopPropagation();
                            onAskMaxwell(asset);
                          }}
                        >
                          <PrismIcon size={18} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Ask Maxwell</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </>
          )}

          {/* Common edit/admin buttons */}
          {canEdit && !asset.is_shared_inbound && (
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-12 px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(asset);
                      }}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Edit</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              {isAdmin && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(asset);
                        }}
                        className="text-muted-foreground hover:text-destructive h-9 w-9"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Delete</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </>
          )}
        </div>
      </CardContent>
      {showShareDialog && (
        <ShareConfigurationDialog 
          open={showShareDialog} 
          onOpenChange={setShowShareDialog} 
          entityId={asset.id} 
          entityType={asset.type === 'asset' ? 'tool' : 'part'} 
          entityName={asset.name} 
        />
      )}
    </Card>
  );
});

CombinedAssetCard.displayName = 'CombinedAssetCard';
CombinedAssetCard.displayName = 'CombinedAssetCard';