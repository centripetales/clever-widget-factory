import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Filter, Plus, X, ChevronDown, Network } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useSharedOrgs } from "@/hooks/useSharedOrgs";
import { useOrganization } from "@/hooks/useOrganization";

interface CombinedAssetFiltersProps {
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  isSemanticSearching?: boolean;
  onSemanticSearch: () => void;
  onClearSearch?: () => void;
  searchDescriptions: boolean;
  setSearchDescriptions: (show: boolean) => void;
  showMyCheckedOut: boolean;
  setShowMyCheckedOut: (show: boolean) => void;
  showLowStock: boolean;
  setShowLowStock: (show: boolean) => void;
  showOnlyAssets: boolean;
  setShowOnlyAssets: (show: boolean) => void;
  showOnlyStock: boolean;
  setShowOnlyStock: (show: boolean) => void;
  showOnlyAreas: boolean;
  setShowOnlyAreas: (show: boolean) => void;
  showRemovedItems: boolean;
  setShowRemovedItems: (show: boolean) => void;
  actionButton?: React.ReactNode;
}

export const CombinedAssetFilters = ({
  searchTerm,
  setSearchTerm,
  isSemanticSearching = false,
  onSemanticSearch,
  onClearSearch,
  searchDescriptions,
  setSearchDescriptions,
  showMyCheckedOut,
  setShowMyCheckedOut,
  showLowStock,
  setShowLowStock,
  showOnlyAssets,
  setShowOnlyAssets,
  showOnlyStock,
  setShowOnlyStock,
  showOnlyAreas,
  setShowOnlyAreas,
  showRemovedItems,
  setShowRemovedItems,
  actionButton
}: CombinedAssetFiltersProps) => {
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);

  // Partner org sharing filter state
  const { selectedOrgs, toggleOrg } = useSharedOrgs();
  const { organization: currentOrganization, accessibleOrganizations } = useOrganization();
  // All orgs the user can access, excluding their current active org
  const otherOrgs = accessibleOrganizations.filter(
    (o) => o.id !== currentOrganization?.id
  );

  const activeFilterCount =
    (showMyCheckedOut ? 1 : 0) +
    (showLowStock ? 1 : 0) +
    (showOnlyAssets ? 1 : 0) +
    (showOnlyStock ? 1 : 0) +
    (showOnlyAreas ? 1 : 0) +
    (showRemovedItems ? 1 : 0) +
    (searchDescriptions ? 1 : 0) +
    selectedOrgs.length;

  return (
    <div className="space-y-4">
      {/* Search Bar with AI Search Button */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, serial number, or storage location..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-10"
          />
          {searchTerm && (
            <button
              onClick={() => {
                setSearchTerm("");
                onClearSearch?.();
              }}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          onClick={onSemanticSearch}
          disabled={!searchTerm.trim() || isSemanticSearching}
          variant="secondary"
          title="AI-powered semantic search"
        >
          {isSemanticSearching ? (
            <div className="animate-spin h-4 w-4 border-2 border-muted-foreground border-t-transparent rounded-full" />
          ) : (
            <Search className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Collapsible Filters */}
      <Collapsible open={isFiltersOpen} onOpenChange={setIsFiltersOpen}>
        <div className="flex items-center justify-between gap-4">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="flex items-center gap-2">
              <Filter className="h-4 w-4" />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {activeFilterCount}
                </span>
              )}
              <ChevronDown className={`h-4 w-4 transition-transform ${isFiltersOpen ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>

          {actionButton}
        </div>

        <CollapsibleContent className="mt-4">
          <div className="space-y-4">
            {/* Standard toggle filters */}
            <div className="flex flex-wrap gap-4 items-center">

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center space-x-2">
                      <Switch
                        id="my-checked-out"
                        checked={showMyCheckedOut}
                        onCheckedChange={setShowMyCheckedOut}
                      />
                      <Label htmlFor="my-checked-out" className="text-sm">
                        My Checked Out
                      </Label>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Show only assets currently checked out to me</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center space-x-2">
                      <Switch
                        id="low-stock"
                        checked={showLowStock}
                        onCheckedChange={setShowLowStock}
                      />
                      <Label htmlFor="low-stock" className="text-sm">
                        Low Stock
                      </Label>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Show only stock items below minimum quantity</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <div className="flex items-center gap-4">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="search-descriptions"
                    checked={searchDescriptions}
                    onCheckedChange={setSearchDescriptions}
                  />
                  <Label htmlFor="search-descriptions" className="text-sm">
                    Include Descriptions
                  </Label>
                </div>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center space-x-2">
                        <Switch
                          id="only-assets"
                          checked={showOnlyAssets}
                          onCheckedChange={(checked) => {
                            setShowOnlyAssets(checked);
                            if (checked) {
                              setShowOnlyStock(false);
                              setShowOnlyAreas(false);
                            }
                          }}
                        />
                        <Label htmlFor="only-assets" className="text-sm">
                          Assets Only
                        </Label>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Show only trackable assets (items with serial numbers)</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center space-x-2">
                        <Switch
                          id="only-stock"
                          checked={showOnlyStock}
                          onCheckedChange={(checked) => {
                            setShowOnlyStock(checked);
                            if (checked) {
                              setShowOnlyAssets(false);
                              setShowOnlyAreas(false);
                            }
                          }}
                        />
                        <Label htmlFor="only-stock" className="text-sm">
                          Stock Only
                        </Label>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Show only consumable stock items</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center space-x-2">
                        <Switch
                          id="only-areas"
                          checked={showOnlyAreas}
                          onCheckedChange={(checked) => {
                            setShowOnlyAreas(checked);
                            if (checked) {
                              setShowOnlyAssets(false);
                              setShowOnlyStock(false);
                            }
                          }}
                        />
                        <Label htmlFor="only-areas" className="text-sm">
                          Areas Only
                        </Label>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Show only Infrastructure/Container/Field areas (parent structures), sorted by item count</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center space-x-2">
                      <Switch
                        id="removed-items"
                        checked={showRemovedItems}
                        onCheckedChange={setShowRemovedItems}
                      />
                      <Label htmlFor="removed-items" className="text-sm">
                        Show Removed
                      </Label>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Include removed/deleted items in the list</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            {/* Partner org shared-asset filter */}
            {otherOrgs.length > 0 && (
              <div className="border-t pt-3">
                <div className="flex items-center gap-2 mb-2">
                  <Network className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-medium text-muted-foreground">
                    Include shared assets from partner orgs
                  </span>
                </div>
                <div className="flex flex-wrap gap-3">
                  {otherOrgs.map((org) => (
                    <div
                      key={org.id}
                      className="flex items-center space-x-2 bg-muted/50 px-3 py-1.5 rounded-md border border-border"
                    >
                      <Checkbox
                        id={`shared-org-${org.id}`}
                        checked={selectedOrgs.includes(org.id)}
                        onCheckedChange={() => toggleOrg(org.id)}
                        className="data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                      />
                      <Label
                        htmlFor={`shared-org-${org.id}`}
                        className="text-sm font-medium cursor-pointer select-none"
                      >
                        {org.name}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};