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
  onView: (asset: CombinedAsset) => void;
  onEdit: (asset: CombinedAsset) => void;
  onRemove: (asset: CombinedAsset) => void;
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
  onView,
  onEdit,
  onRemove,
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
          onView={onView}
          onEdit={onEdit}
          onRemove={onRemove}
          onAddObservation={onAddObservation}
          onAddQuantity={onAddQuantity}
          onUseQuantity={onUseQuantity}
          onAskMaxwell={onAskMaxwell}
          itemCount={itemCount}
        />
      </div>
    );
  }, [assets, canEdit, isAdmin, currentUserId, currentUserEmail, onView, onEdit, onRemove, onAddObservation, onAddQuantity, onUseQuantity, onAskMaxwell, areaItemCounts]);

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