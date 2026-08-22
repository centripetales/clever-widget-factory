import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { CombinedAsset } from '@/hooks/useCombinedAssets';
import { toolsQueryKey, partsQueryKey } from '@/lib/queryKeys';
import { apiService } from '@/lib/apiService';
import { useToolHistory } from '@/hooks/tools/useToolHistory';
import { ToolDetails } from '@/components/tools/ToolDetails';
import { StockDetails } from '@/components/StockDetails';

// Real route for "view an asset's details/history" (was previously a local
// component-state swap inside CombinedAssetsContainer with no URL of its
// own — navigating away, e.g. to edit an observation, lost the view and the
// active tab entirely; navigate(-1) just landed back on the plain list).
// Having this on the URL means back-navigation restores both the asset and
// the tab for free, and the view is now shareable/bookmarkable.
export default function AssetDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [asset, setAsset] = useState<CombinedAsset | null>(null);
  const [loading, setLoading] = useState(true);

  const activeTab = searchParams.get('tab') || 'details';
  const handleTabChange = useCallback((tab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const { toolHistory, fetchToolHistory, loading: toolHistoryLoading } = useToolHistory(asset?.type === 'asset' ? id : undefined);

  useEffect(() => {
    if (!id) return;

    const toolsData = queryClient.getQueryData<any[]>(toolsQueryKey());
    const partsData = queryClient.getQueryData<any[]>(partsQueryKey());

    const foundTool = toolsData?.find((t: any) => t.id === id);
    if (foundTool) {
      setAsset({ ...foundTool, type: 'asset' } as CombinedAsset);
      setLoading(false);
      return;
    }

    const foundPart = partsData?.find((p: any) => p.id === id);
    if (foundPart) {
      setAsset({ ...foundPart, type: 'stock' } as CombinedAsset);
      setLoading(false);
      return;
    }

    const fetchAsset = async () => {
      try {
        const toolsResult = await apiService.get('/tools?limit=2000');
        const tools = toolsResult.data || [];
        const matchedTool = tools.find((t: any) => t.id === id);
        if (matchedTool) {
          setAsset({ ...matchedTool, type: 'asset' } as CombinedAsset);
          setLoading(false);
          return;
        }

        const partsResult = await apiService.get('/parts?limit=2000');
        const parts = partsResult.data || [];
        const matchedPart = parts.find((p: any) => p.id === id);
        if (matchedPart) {
          setAsset({ ...matchedPart, type: 'stock' } as CombinedAsset);
          setLoading(false);
          return;
        }

        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch asset:', err);
        setLoading(false);
      }
    };

    fetchAsset();
  }, [id, queryClient]);

  useEffect(() => {
    if (asset?.type === 'asset' && id) {
      fetchToolHistory(id);
    }
  }, [asset?.type, id, fetchToolHistory]);

  const handleBack = useCallback(() => {
    const hasHistory = window.history.state && window.history.state.idx > 0;
    if (hasHistory) {
      navigate(-1);
    } else {
      navigate('/combined-assets');
    }
  }, [navigate]);

  if (loading) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="container mx-auto p-6 text-center text-muted-foreground">
        Asset not found.
      </div>
    );
  }

  if (asset.type === 'asset') {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <ToolDetails
          tool={asset as any}
          toolHistory={toolHistory}
          toolHistoryLoading={toolHistoryLoading}
          onBack={handleBack}
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <StockDetails stock={asset} onBack={handleBack} onRefresh={() => {}} />
    </div>
  );
}
