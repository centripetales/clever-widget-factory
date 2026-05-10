import { CombinedAsset } from "@/hooks/useCombinedAssets";
import { CombinedAssetCard } from "./CombinedAssetCard";
import { VirtuosoGrid } from "react-virtuoso";
import { useCallback, useRef } from "react";

interface CombinedAssetGridProps {
  assets: CombinedAsset[];
  canEdit: boolean;
  isAdmin: boolean;
  currentUserId?: string;
  currentUserEmail?: string;
  userNameMap?: Map<string, string>;
  onView: (asset: CombinedAsset) => void;
  onEdit: (asset: CombinedAsset) => void;
  onRemove: (asset: CombinedAsset) => void;
  onCheckout: (asset: CombinedAsset) => void;
  onCheckin: (asset: CombinedAsset) => void;
  onAddObservation?: (asset: CombinedAsset) => void;
  onAddQuantity?: (asset: CombinedAsset) => void;
  onUseQuantity?: (asset: CombinedAsset) => void;
  onAskMaxwell?: (asset: CombinedAsset) => void;
  areaItemCounts?: Map<string, number>;
  // Infinite scroll props
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
}

export const CombinedAssetGrid = ({
  assets,
  canEdit,
  isAdmin,
  currentUserId,
  currentUserEmail,
  userNameMap,
  onView,
  onEdit,
  onRemove,
  onCheckout,
  onCheckin,
  onAddObservation,
  onAddQuantity,
  onUseQuantity,
  onAskMaxwell,
  areaItemCounts,
  // Infinite scroll props
  onLoadMore,
  hasMore = false,
  loading = false
}: CombinedAssetGridProps) => {
  // Memoize the itemContent function to prevent recreating it on every render
  const itemContent = useCallback((index: number) => {
    const asset = assets[index];
    if (!asset) {
      return <div className="h-40 rounded-md border animate-pulse" style={{ height: '300px' }} />;
    }
    const resolvedCheckoutName = asset.checked_out_user_id ? userNameMap?.get(asset.checked_out_user_id) : undefined;
    const checkoutDisplayName = resolvedCheckoutName && resolvedCheckoutName.trim().length > 0
      ? resolvedCheckoutName
      : asset.checked_out_to || undefined;

    const itemCount = areaItemCounts?.get(asset.id);

    return (
      <div>
        <CombinedAssetCard
          key={asset.id}
          asset={asset}
          canEdit={canEdit}
          isAdmin={isAdmin}
          currentUserId={currentUserId}
          currentUserEmail={currentUserEmail}
          checkoutInfo={asset.type === 'asset' && asset.is_checked_out ? {
            user_name: checkoutDisplayName || 'Unknown',
            user_id: asset.checked_out_user_id || '',
            checkout_date: asset.checked_out_date || undefined
          } : undefined}
          onView={onView}
          onEdit={onEdit}
          onRemove={onRemove}
          onCheckout={onCheckout}
          onCheckin={onCheckin}
          onAddObservation={onAddObservation}
          onAddQuantity={onAddQuantity}
          onUseQuantity={onUseQuantity}
          onAskMaxwell={onAskMaxwell}
          itemCount={itemCount}
        />
      </div>
    );
  }, [assets, canEdit, isAdmin, currentUserId, currentUserEmail, onView, onEdit, onRemove, onCheckout, onCheckin, onAddObservation, onAddQuantity, onUseQuantity, onAskMaxwell, userNameMap, areaItemCounts]);

  if (assets.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No assets or stock items found matching your criteria.
      </div>
    );
  }

  return (
    <VirtuosoGrid
      totalCount={assets.length}
      overscan={200}
      style={{ height: '75vh' }}
      computeItemKey={(index) => assets[index]?.id || `item-${index}`}
      listClassName="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
      itemContent={itemContent}
      // Infinite scroll functionality
      endReached={onLoadMore}
      components={{
        Footer: () => {
          if (!hasMore) return null;
          return (
            <div className="flex justify-center p-4">
              {loading ? (
                <div className="text-muted-foreground">Loading more...</div>
              ) : (
                <div className="text-muted-foreground">Scroll for more</div>
              )}
            </div>
          );
        }
      }}
    />
  );
};