import { ArrowLeft, Plus, Zap, MapPin, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tool } from "@/hooks/tools/useToolsData";
import { HistoryEntry, AssetHistoryEntry, ObservationHistoryEntry } from "@/hooks/tools/useToolHistory";
import { ToolStatusBadge } from "./ToolStatusBadge";
import { ExperienceCreationDialog } from "@/components/ExperienceCreationDialog";
import { useState } from "react";
import { getThumbnailUrl } from '@/lib/imageUtils';
import { Link } from "react-router-dom";

interface ToolDetailsProps {
  tool: Tool;
  toolHistory: HistoryEntry[];
  onBack: () => void;
  defaultTab?: string;
}

export const ToolDetails = ({
  tool,
  toolHistory,
  onBack,
  defaultTab = 'details',
}: ToolDetailsProps) => {
  const [isExperienceDialogOpen, setIsExperienceDialogOpen] = useState(false);

  const isAssetHistory = (record: HistoryEntry): record is AssetHistoryEntry => {
    return (record as AssetHistoryEntry).type === 'asset_change';
  };

  const isObservation = (record: HistoryEntry): record is ObservationHistoryEntry => {
    return (record as ObservationHistoryEntry).type === 'observation';
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
          <Tabs defaultValue={defaultTab} className="w-full">
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

              {tool.gps_latitude && tool.gps_longitude && (
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
                        src={`https://maps.google.com/maps?q=${tool.gps_latitude},${tool.gps_longitude}&hl=en&z=17&t=k&output=embed`}
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
                      src={`https://maps.google.com/maps?q=${tool.gps_latitude},${tool.gps_longitude}&hl=en&z=17&t=k&output=embed`}
                      allowFullScreen
                    ></iframe>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <div className="space-y-4">
                {toolHistory.map((record) => (
                  <Card key={record.id}>
                    <CardContent className="p-4">
                      {isAssetHistory(record) ? (
                        <>
                          <div className="flex justify-between items-start mb-2">
                            <div className="flex items-start gap-2">
                              {record.change_type === 'action_created' ? (
                                <Zap className="h-4 w-4 mt-0.5 text-purple-600" />
                              ) : (
                                <div className="h-4 w-4 mt-0.5 rounded-full bg-blue-100 flex items-center justify-center">
                                  <div className="h-2 w-2 rounded-full bg-blue-600" />
                                </div>
                              )}
                              <div>
                                <p className="font-medium">{record.user_name}</p>
                                <p className="text-sm text-muted-foreground">
                                  {new Date(record.changed_at).toLocaleDateString()} {new Date(record.changed_at).toLocaleTimeString()}
                                </p>
                              </div>
                            </div>
                            <Badge variant="outline" className="capitalize">
                              {record.change_type === 'created' ? 'Created' :
                                record.change_type === 'action_created' ? 'Action' :
                                  record.change_type === 'status_change' ? 'Status Changed' :
                                    record.change_type === 'updated' ? 'Updated' : record.change_type}
                            </Badge>
                          </div>

                          {record.change_type === 'action_created' && record.action_title && (
                            <div className="text-sm bg-purple-50 border border-purple-200 p-3 rounded mt-2">
                              <p className="font-medium text-purple-900 mb-1">Action:</p>
                              {record.action_id ? (
                                <Link
                                  to={`/actions/${record.action_id}`}
                                  className="text-purple-600 hover:text-purple-800 underline"
                                >
                                  {record.action_title}
                                </Link>
                              ) : (
                                <p className="text-purple-800">{record.action_title}</p>
                              )}
                              {record.action_status && (
                                <Badge variant="outline" className="mt-1 text-xs">{record.action_status}</Badge>
                              )}
                            </div>
                          )}

                          {record.change_type !== 'action_created' && record.field_changed && (
                            <p className="text-sm mb-2">
                              <span className="font-medium">Field Changed:</span> {record.field_changed}
                              {record.old_value && record.new_value && (
                                <span className="text-muted-foreground">
                                  {' '}({record.old_value} → {record.new_value})
                                </span>
                              )}
                            </p>
                          )}

                          {record.notes && record.change_type !== 'created' && record.change_type !== 'action_created' && (
                            <p className="text-sm text-muted-foreground">{record.notes}</p>
                          )}
                        </>
                      ) : isObservation(record) ? (
                        <>
                          <div className="flex justify-between items-start mb-2">
                            <div>
                              <p className="font-medium">{record.observed_by_name}</p>
                              <p className="text-sm text-muted-foreground">
                                {new Date(record.observed_at).toLocaleDateString()} {new Date(record.observed_at).toLocaleTimeString()}
                              </p>
                            </div>
                            <Badge variant="outline">Observation</Badge>
                          </div>
                          {record.observation_text && (
                            <p className="text-sm">{record.observation_text}</p>
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
              <CardContent className="p-4 flex flex-col gap-4">
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
