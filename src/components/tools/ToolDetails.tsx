import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Tool } from "@/hooks/tools/useToolsData";
import { CheckoutHistory, HistoryEntry, AssetHistoryEntry } from "@/hooks/tools/useToolHistory";
import { ToolStatusBadge } from "./ToolStatusBadge";
import { ExperienceCreationDialog } from "@/components/ExperienceCreationDialog";
import { useState } from "react";
import { getThumbnailUrl } from '@/lib/imageUtils';

interface ToolDetailsProps {
  tool: Tool;
  toolHistory: HistoryEntry[];
  currentCheckout: { user_name: string } | null;
  onBack: () => void;
}

export const ToolDetails = ({
  tool,
  toolHistory,
  currentCheckout,
  onBack
}: ToolDetailsProps) => {
  const [isExperienceDialogOpen, setIsExperienceDialogOpen] = useState(false);
  
  const isAssetHistory = (record: HistoryEntry): record is AssetHistoryEntry => {
    return (record as AssetHistoryEntry).type === 'asset_change';
  };

  const isCreationHistory = (record: HistoryEntry): record is CheckoutHistory => {
    return (record as AssetHistoryEntry).type !== 'asset_change' && (record as CheckoutHistory).checkin?.checkin_reason === 'asset_created';
  };

  const isCheckoutHistory = (record: HistoryEntry): record is CheckoutHistory => {
    return (record as AssetHistoryEntry).type !== 'asset_change' && 
           (record as CheckoutHistory).checkin?.checkin_reason !== 'asset_created';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Tools
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{tool.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <ToolStatusBadge status={tool.status} />
            {currentCheckout && (
              <Badge variant="secondary">
                Checked out by: {currentCheckout.user_name}
              </Badge>
            )}
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
                  <CardTitle>Tool Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <span className="font-medium">Category:</span> {tool.category || 'Uncategorized'}
                  </div>
                  <div>
                    <span className="font-medium">Description:</span> {tool.description || 'No description'}
                  </div>
                  <div>
                    <span className="font-medium">Serial Number:</span> {tool.serial_number || 'Not specified'}
                  </div>
                  {tool.parent_structure_name && (
                    <div>
                      <span className="font-medium">Area:</span> {tool.parent_structure_name}
                    </div>
                  )}
                  {tool.storage_location && (
                    <div>
                      <span className="font-medium">Specific Location:</span> {tool.storage_location}
                    </div>
                  )}
                  {tool.actual_location && (
                    <div>
                      <span className="font-medium">Actual Location:</span> {tool.actual_location}
                    </div>
                  )}
                  {tool.last_maintenance && (
                    <div>
                      <span className="font-medium">Last Maintenance:</span> {tool.last_maintenance}
                    </div>
                  )}
                  {tool.manual_url && (
                    <div>
                      <span className="font-medium">Manual:</span>{' '}
                      <a 
                        href={tool.manual_url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        View Manual
                      </a>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>



            <TabsContent value="history" className="space-y-4">
              <div className="space-y-4">
                {toolHistory.map((record) => (
                  <Card key={record.id}>
                    <CardContent className="p-4">
                      {isAssetHistory(record) ? (
                        // Asset History
                        <>
                          <div className="flex justify-between items-start mb-2">
                            <div className="flex items-start gap-2">
                              <div className="h-4 w-4 mt-0.5 rounded-full bg-blue-100 flex items-center justify-center">
                                <div className="h-2 w-2 rounded-full bg-blue-600"></div>
                              </div>
                              <div>
                                <p className="font-medium">{record.user_name}</p>
                                <p className="text-sm text-muted-foreground">
                                  {new Date(record.changed_at).toLocaleDateString()} {new Date(record.changed_at).toLocaleTimeString()}
                                </p>
                              </div>
                            </div>
                            <Badge variant="outline" className="capitalize">
                              {record.change_type === 'created' ? 'Created' :
                               record.change_type === 'status_change' ? 'Status Changed' :
                               record.change_type === 'updated' ? 'Updated' : record.change_type}
                            </Badge>
                          </div>
                          
                          {record.change_type === 'created' && record.notes && (
                            <p className="text-sm mb-2">
                              <span className="font-medium">Details:</span> {record.notes}
                            </p>
                          )}
                          
                          {record.field_changed && (
                            <p className="text-sm mb-2">
                              <span className="font-medium">Field Changed:</span> {record.field_changed}
                              {record.old_value && record.new_value && (
                                <span className="text-muted-foreground">
                                  {' '}({record.old_value} → {record.new_value})
                                </span>
                              )}
                            </p>
                          )}
                          
                          {record.notes && record.change_type !== 'created' && (
                            <p className="text-sm text-muted-foreground">
                              {record.notes}
                            </p>
                          )}
                        </>
                      ) : isCreationHistory(record) ? (
                        // Asset Creation Event
                        <>
                          <div className="mb-2">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="bg-green-100 text-green-800 border-green-300">
                                Asset Created
                              </Badge>
                            </div>
                            <p className="font-medium mt-2">{record.user_name}</p>
                            <p className="text-sm text-muted-foreground">
                              Created on{' '}
                              {(() => {
                                const dateToUse = record.checkin?.checkin_date || record.created_at;
                                return new Date(dateToUse).toLocaleDateString('en-US', {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric'
                                }) + ' at ' + new Date(dateToUse).toLocaleTimeString('en-US', {
                                  hour: 'numeric',
                                  minute: '2-digit',
                                  hour12: true
                                });
                              })()}
                            </p>
                          </div>
                          
                          {record.notes && (
                            <div className="mt-3 p-3 bg-green-50 rounded-md text-sm">
                              <p className="font-medium mb-1 text-green-800">Creation Details:</p>
                              <p className="text-green-700">{record.notes}</p>
                            </div>
                          )}
                        </>
                      ) : isCheckoutHistory(record) ? (
                        // Checkout/Check-in History
                        <>
                          <div className="mb-2">
                            <div>
                              <p className="font-medium">{record.user_name}</p>
                              <p className="text-sm text-muted-foreground">
                                {record.type === 'checkin' ? 'Check-in' : 'Checkout'} on{' '}
                                {(() => {
                                  const dateToUse = record.type === 'checkin' && record.checkin?.checkin_date 
                                    ? record.checkin.checkin_date 
                                    : (record.checkout_date || record.created_at);
                                  return new Date(dateToUse).toLocaleDateString('en-US', {
                                    year: 'numeric',
                                    month: 'short',
                                    day: 'numeric'
                                  }) + ' at ' + new Date(dateToUse).toLocaleTimeString('en-US', {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    hour12: true
                                  });
                                })()}
                              </p>
                            </div>
                          </div>
                          
                          {record.intended_usage && (
                            <p className="text-sm mb-2">
                              <span className="font-medium">Intended Usage:</span>{' '}
                              {record.action_id ? (
                                <a 
                                  href={`/actions/${record.action_id}`}
                                  className="text-blue-600 hover:text-blue-800 underline"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {record.intended_usage}
                                </a>
                              ) : (
                                record.intended_usage
                              )}
                            </p>
                          )}
                          
                          {/* Notes removed from checkout display per new guidance */}

                          {record.checkin && (
                            <div className="mt-3 p-3 bg-muted rounded-md text-sm">
                              <p className="font-medium mb-1">Check-in Details:</p>
                              {/* Combined: Check-in timestamp and duration */}
                              {record.checkin.checkin_date && (
                                <p className="mb-1">
                                  <span className="font-medium">Check In at:</span>{' '}
                                  {(() => {
                                    const end = new Date(record.checkin!.checkin_date);
                                    const tsStr = end.toLocaleDateString('en-US', {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric'
                                    }) + ' at ' + end.toLocaleTimeString('en-US', {
                                      hour: 'numeric',
                                      minute: '2-digit',
                                      hour12: true
                                    });
                                    if (!record.checkout_date) return tsStr;
                                    const start = new Date(record.checkout_date as string);
                                    const ms = Math.max(0, end.getTime() - start.getTime());
                                    const minutes = Math.floor(ms / 60000);
                                    const days = Math.floor(minutes / (60 * 24));
                                    const hours = Math.floor((minutes % (60 * 24)) / 60);
                                    const mins = minutes % 60;
                                    const parts: string[] = [];
                                    if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
                                    if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
                                    if (mins) parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
                                    const duration = parts.join(', ');
                                    return duration ? `${tsStr} after ${duration}` : tsStr;
                                  })()}
                                </p>
                              )}
                              {record.checkin.checkin_reason && (
                                <p className="mb-1">
                                  <span className="font-medium">Reason:</span> {record.checkin.checkin_reason}
                                </p>
                              )}
                              {record.checkin.problems_reported && (
                                <p className="mb-1">
                                  <span className="font-medium">Problems:</span> {record.checkin.problems_reported}
                                </p>
                              )}
                              {record.checkin.hours_used && (
                                <p className="mb-1">
                                  <span className="font-medium">Hours Used:</span> {record.checkin.hours_used}
                                </p>
                              )}
                              {record.checkin.what_did_you_do && (
                                <p className="mb-1">
                                  <span className="font-medium">Work Done:</span> {record.checkin.what_did_you_do}
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      ) : null}
                    </CardContent>
                  </Card>
                ))}
                
                {toolHistory.length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No history available.
                  </p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-6">
          {tool.image_url && (
            <Card>
              <CardContent className="p-4">
                <img
                  src={getThumbnailUrl(tool.image_url) || ''}
                  alt={tool.name}
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
        entityType="tool"
        entityId={tool.id}
        entityName={tool.name}
      />
    </div>
  );
};