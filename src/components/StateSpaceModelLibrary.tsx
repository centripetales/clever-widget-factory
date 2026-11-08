import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, Library } from 'lucide-react';
import { useStateSpaceModels, useCreateModelAssociation } from '@/hooks/useStateSpaceModels';
import { isExpectation } from '@/lib/expectationModels';
import { useToast } from '@/hooks/use-toast';
import { apiService } from '@/lib/apiService';
import type { StateSpaceModelRecord } from '@/lib/stateSpaceApi';

interface StateSpaceModelLibraryProps {
  entityId: string;
  entityType?: string;
  /** @deprecated Use entityId instead */
  actionId?: string;
  onSelect: (model: StateSpaceModelRecord) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StateSpaceModelLibrary({
  entityId,
  entityType = 'action',
  actionId: _actionId,
  onSelect,
  open,
  onOpenChange,
}: StateSpaceModelLibraryProps) {
  // Support legacy actionId prop
  const resolvedEntityId = entityId || _actionId || '';
  const { toast } = useToast();
  const { data: modelsResponse, isLoading: isLoadingModels } = useStateSpaceModels();
  const createAssociation = useCreateModelAssociation();

  const [searchQuery, setSearchQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<string[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isAssociating, setIsAssociating] = useState(false);

  // Expectation models (a tool's metrics over time, set with Claude) aren't
  // state-space models this page can open; they show on the tool's page.
  const models = (modelsResponse?.data ?? []).filter((m) => !isExpectation(m));

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setSemanticResults(null);
      setIsSearching(false);
    }
  }, [open]);

  // Debounced semantic search
  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSemanticResults(null);
      return;
    }

    setIsSearching(true);
    try {
      const response = await apiService.post<{
        data: { results: { entity_id: string }[] };
      }>('/semantic-search/unified', {
        query: query.trim(),
        entity_types: ['state_space_model'],
        limit: 20,
      });

      if (response.data?.results) {
        setSemanticResults(response.data.results.map((r) => r.entity_id));
      }
    } catch {
      // Fall back to showing all models on search error
      setSemanticResults(null);
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Trigger search after typing stops
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSemanticResults(null);
      return;
    }

    const timer = setTimeout(() => {
      handleSearch(searchQuery);
    }, 400);

    return () => clearTimeout(timer);
  }, [searchQuery, handleSearch]);

  // Filter models: use semantic results if available, otherwise show all
  const filteredModels = semanticResults
    ? models.filter((m) => semanticResults.includes(m.id))
    : models;

  const handleSelectModel = async (model: StateSpaceModelRecord) => {
    setIsAssociating(true);
    try {
      await createAssociation.mutateAsync({
        modelId: model.id,
        entityType,
        entityId: resolvedEntityId,
      });
      onSelect(model);
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'Failed to link model',
        description: err instanceof Error ? err.message : 'Could not associate model with this action.',
        variant: 'destructive',
      });
    } finally {
      setIsAssociating(false);
    }
  };

  const isLoading = isLoadingModels || isSearching;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="h-5 w-5" />
            Model Library
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search models by name or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="ml-2 text-muted-foreground">
              {isSearching ? 'Searching...' : 'Loading models...'}
            </span>
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground">No models found</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredModels.map((model) => (
              <button
                key={model.id}
                onClick={() => handleSelectModel(model)}
                disabled={isAssociating}
                className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{model.name}</span>
                      {model.version && (
                        <span className="text-xs text-muted-foreground">v{model.version}</span>
                      )}
                      {model.is_public && (
                        <Badge variant="secondary" className="text-xs">Public</Badge>
                      )}
                    </div>
                    {model.author && (
                      <p className="text-sm text-muted-foreground mt-0.5">by {model.author}</p>
                    )}
                    {model.description && (
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {model.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-xs text-muted-foreground">
                        {Object.keys(model.model_definition?.state_definitions ?? {}).length} states
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {Object.keys(model.model_definition?.state_update_equations ?? {}).length} equations
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {isAssociating && (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm text-muted-foreground">Linking model...</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
