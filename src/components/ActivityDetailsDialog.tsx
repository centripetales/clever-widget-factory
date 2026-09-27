import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Button } from "./ui/button";
import { ChevronDown, ChevronUp, Edit } from "lucide-react";
import { format } from "date-fns";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

interface DetailedActivityRecord {
  id: string;
  date: string;
  user: string;
  userName: string;
  type: 'created' | 'modified' | 'used';
  partName: string;
  partDescription?: string;
  changeReason?: string;
  usageDescription?: string;
  quantityUsed?: number;
  taskTitle?: string;
  timestamp: string;
  partId: string;
  // Additional fields for parts_history
  oldQuantity?: number;
  newQuantity?: number;
  quantityChange?: number;
  changeType?: string;
}

interface ActivityDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate: string | null;
  detailedActivity: DetailedActivityRecord[];
  selectedUsers: string[];
}

export function ActivityDetailsDialog({ 
  open, 
  onOpenChange, 
  selectedDate, 
  detailedActivity,
  selectedUsers 
}: ActivityDetailsDialogProps) {
  const navigate = useNavigate();
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    created: true,
    modified: true,
    used: true
  });

  if (!selectedDate) return null;

  const handleEditItem = (partId: string) => {
    // Close this dialog first to avoid state conflicts
    onOpenChange(false);
    
    const params = new URLSearchParams({
      edit: partId,
      return: 'activity-details',
      date: selectedDate,
      users: selectedUsers.join(',')
    });
    navigate(`/combined-assets?view=stock&${params.toString()}`);
  };

  const dateActivities = detailedActivity.filter(
    activity => activity.date === selectedDate && selectedUsers.includes(activity.userName)
  );

  const createdActivities = dateActivities.filter(a => a.type === 'created');
  const modifiedActivities = dateActivities.filter(a => a.type === 'modified');
  const usedActivities = dateActivities.filter(a => a.type === 'used');

  const ActivitySection = ({ 
    title, 
    activities, 
    type 
  }: { 
    title: string; 
    activities: DetailedActivityRecord[]; 
    type: 'created' | 'modified' | 'used';
  }) => {
    if (activities.length === 0) return null;

    const getTypeColor = (type: string) => {
      switch (type) {
        case 'created': return 'hsl(var(--mission-education))';
        case 'modified': return 'hsl(var(--mission-construction))';
        case 'used': return 'hsl(var(--mission-research))';
        default: return 'hsl(var(--muted))';
      }
    };

    const isOpen = openSections[type];

    return (
      <Collapsible 
        open={isOpen} 
        onOpenChange={(open) => setOpenSections(prev => ({ ...prev, [type]: open }))}
      >
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between p-2 hover:bg-muted/50 rounded-lg">
            <div className="flex items-center space-x-2">
              <h4 className="font-medium text-sm">{title}</h4>
              <Badge 
                variant="secondary" 
                style={{ backgroundColor: getTypeColor(type), color: 'white' }}
              >
                {activities.length}
              </Badge>
            </div>
            {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </div>
        </CollapsibleTrigger>
        
        <CollapsibleContent className="space-y-2 mt-2 pl-2">
          {activities.map((activity) => (
            <div key={activity.id} className="border rounded-lg p-3 space-y-2">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <h5 className="font-medium text-sm">{activity.partName}</h5>
                  {activity.partDescription && (
                    <p className="text-xs text-muted-foreground mt-1">{activity.partDescription}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEditItem(activity.partId)}
                    className="h-6 px-2 text-xs"
                  >
                    <Edit className="h-3 w-3 mr-1" />
                    Edit
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(activity.timestamp), 'HH:mm')}
                  </span>
                </div>
              </div>
              
              <div className="space-y-1">
                <p className="text-xs">
                  <span className="text-muted-foreground">User:</span> {activity.userName}
                </p>
                
                {type === 'used' && (
                  <>
                    {activity.quantityUsed && (
                      <p className="text-xs">
                        <span className="text-muted-foreground">Quantity Used:</span> {activity.quantityUsed}
                      </p>
                    )}
                    {activity.taskTitle && (
                      <p className="text-xs">
                        <span className="text-muted-foreground">Task:</span> {activity.taskTitle}
                      </p>
                    )}
                    {activity.usageDescription && (
                      <div className="bg-blue-50 rounded p-2 mt-2">
                        <p className="text-xs">
                          <span className="text-muted-foreground font-medium">Usage Description:</span>
                        </p>
                        <p className="text-xs mt-1">{activity.usageDescription}</p>
                      </div>
                    )}
                  </>
                )}
                
                {(type === 'created' || type === 'modified') && (
                  <>
                    {activity.changeReason && (
                      <div className="bg-gray-50 rounded p-2 mt-2">
                        <p className="text-xs">
                          <span className="text-muted-foreground font-medium">
                            {type === 'created' ? 'Addition Reason:' : 'Edit Reason:'}
                          </span>
                        </p>
                        <p className="text-xs mt-1">{activity.changeReason}</p>
                      </div>
                    )}
                    {activity.changeType && (
                      <p className="text-xs">
                        <span className="text-muted-foreground">Operation:</span> {activity.changeType}
                      </p>
                    )}
                    {(activity.oldQuantity !== undefined || activity.newQuantity !== undefined || activity.quantityChange !== undefined) && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {activity.oldQuantity !== undefined && (
                          <p className="text-xs">
                            <span className="text-muted-foreground">Previous:</span> {activity.oldQuantity}
                          </p>
                        )}
                        {activity.newQuantity !== undefined && (
                          <p className="text-xs">
                            <span className="text-muted-foreground">New:</span> {activity.newQuantity}
                          </p>
                        )}
                      </div>
                    )}
                    {activity.quantityChange !== undefined && activity.quantityChange !== 0 && (
                      <p className="text-xs">
                        <span className="text-muted-foreground">Change:</span> 
                        <span className={`ml-1 font-medium ${activity.quantityChange > 0 ? "text-green-600" : activity.quantityChange < 0 ? "text-red-600" : "text-gray-600"}`}>
                          {activity.quantityChange > 0 ? '+' : ''}{activity.quantityChange}
                        </span>
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Activity Details for {selectedDate}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {dateActivities.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">
              No activity found for this date with the selected user filters.
            </p>
          ) : (
            <>
              <ActivitySection 
                title="Created" 
                activities={createdActivities} 
                type="created" 
              />
              
              {createdActivities.length > 0 && modifiedActivities.length > 0 && (
                <Separator />
              )}
              
              <ActivitySection 
                title="Modified" 
                activities={modifiedActivities} 
                type="modified" 
              />
              
              {(createdActivities.length > 0 || modifiedActivities.length > 0) && usedActivities.length > 0 && (
                <Separator />
              )}
              
              <ActivitySection 
                title="Used" 
                activities={usedActivities} 
                type="used" 
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}