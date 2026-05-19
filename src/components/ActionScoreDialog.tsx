import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Copy, User, Calendar, Wrench, AlertTriangle, CheckCircle, Clock, Sparkles, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useOrganizationId } from "@/hooks/useOrganizationId";
import { useScoringPrompts } from "@/hooks/useScoringPrompts";
import { useActionScores, ActionScore } from "@/hooks/useActionScores";
import { ScoreEntryForm } from "./ScoreEntryForm";
import { ScoreDisplayCard } from "./ScoreDisplayCard";
import { apiService } from '@/lib/apiService';
import { BaseAction, ImplementationUpdate } from "@/types/actions";
import { useQuery } from '@tanstack/react-query';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { actionImplementationUpdatesQueryKey } from '@/lib/queryKeys';

// Utility function to strip HTML tags and decode entities
const stripHtml = (html: string | null | undefined): string => {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
};

interface ActionScoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: BaseAction;
  onScoreUpdated: () => void;
  existingScore?: ActionScore | null;
}

export function ActionScoreDialog({ 
  open, 
  onOpenChange, 
  action,
  onScoreUpdated,
  existingScore 
}: ActionScoreDialogProps) {
  const [selectedPromptId, setSelectedPromptId] = useState<string>("");
  const organizationId = useOrganizationId();
  const [aiResponse, setAiResponse] = useState("");
  const [parsedScores, setParsedScores] = useState<Record<string, { score: number; reason: string }> | null>(null);
  const [rootCauses, setRootCauses] = useState<string[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [showScoreForm, setShowScoreForm] = useState(false); // New state to control form visibility
  const [asset, setAsset] = useState<any>(null);
  const [assetName, setAssetName] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("haiku");
  const [isAutoScoring, setIsAutoScoring] = useState(false);
  const scoreCardRef = useRef<HTMLDivElement>(null);

  const { toast } = useToast();
  const { prompts } = useScoringPrompts();
  const { createScore } = useActionScores();

  // Set default prompt on mount
  useEffect(() => {
    if (prompts.length > 0 && !selectedPromptId) {
      const defaultPrompt = prompts.find((p: any) => p.is_default) || prompts[0];
      setSelectedPromptId(defaultPrompt.id);
    }
  }, [prompts, selectedPromptId]);

  // Fetch implementation updates (stored in states table, linked via state_links)
  const { data: implementationUpdates = [] } = useQuery<ImplementationUpdate[]>({
    queryKey: actionImplementationUpdatesQueryKey(action.id),
    queryFn: async () => {
      const result = await apiService.get(`/action_implementation_updates?action_id=${action.id}`);
      return result.data || [];
    },
    enabled: open && !!action.id,
    ...offlineQueryConfig
  });

  // Set asset when data changes
  useEffect(() => {
    if (action.asset) {
      setAsset(action.asset);
      setAssetName(action.asset.name);
    } else {
      // Ensure we don't leak asset context between different actions
      // If the current action has no asset, clear any previous asset state
      setAsset(null);
      setAssetName("");
    }
  }, [action.asset]);

  // Initialize form based on existing score or create mode
  useEffect(() => {
    if (open) {
      // Always clear state first when opening for a new action
      setIsEditMode(false);
      setSelectedPromptId("");
      setAiResponse("");
      setParsedScores(null);
      setRootCauses([]);
      setShowScoreForm(false);
      
      // Then populate if there's an existing score
      if (existingScore) {
        setIsEditMode(true);
        setSelectedPromptId(existingScore.prompt_id);
        // Only set AI response if it exists and has content
        const aiResponseContent = existingScore.ai_response && Object.keys(existingScore.ai_response).length > 0 
          ? JSON.stringify(existingScore.ai_response, null, 2)
          : "";
        setAiResponse(aiResponseContent);
      } else {
        // Set default prompt if not already set
        if (prompts.length > 0 && !selectedPromptId) {
          const defaultPrompt = prompts.find((p: any) => p.is_default) || prompts[0];
          setSelectedPromptId(defaultPrompt.id);
        }
      }
    } else {
      // Clear everything when dialog closes
      setIsEditMode(false);
      setSelectedPromptId("");
      setAiResponse("");
      setParsedScores(null);
      setRootCauses([]);
      setShowScoreForm(false);
    }
  }, [open, existingScore, action.id]); // Add action.id to dependencies

  const selectedPrompt = prompts.find((p: any) => p.id === selectedPromptId);

  // Aggregate observations from implementation updates
  const aggregatedObservations = implementationUpdates
    .filter(update => update.update_text && update.update_text.trim()) // Filter out null/empty text
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map(update => {
      const date = new Date(update.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
      return `[${date}] ${stripHtml(update.update_text)}`;
    })
    .join('\n\n');

  const generatePrompt = () => {
    if (!selectedPrompt) return "";
    
    // Build action context - only include fields with meaningful content
    const actionContext: any = {
      id: action.id,
      title: action.title,
      status: action.status,
      created_at: action.created_at,
      completed_at: action.completed_at
    };

    // Add optional fields only if they have content
    if (action.description) {
      actionContext.description = action.description;
    }
    
    const policyText = stripHtml(action.policy);
    if (policyText) {
      actionContext.policy = policyText;
    }
    
    // Use aggregated observations from implementation updates, fallback to action.observations
    const observationsText = aggregatedObservations || stripHtml(action.observations);
    if (observationsText) {
      actionContext.observations = observationsText;
    }
    
    if (action.assignee?.full_name) {
      actionContext.assigned_to = action.assignee.full_name;
    }
    
    if (action.required_tools && action.required_tools.length > 0) {
      actionContext.required_tools = action.required_tools;
    }
    
    if (action.required_stock && action.required_stock.length > 0) {
      actionContext.required_stock = action.required_stock;
    }
    
    if (action.issue_reference) {
      actionContext.issue_reference = action.issue_reference;
    }

    // Add asset info only if available
    if (asset || assetName) {
      actionContext.asset = {
        name: assetName,
        id: asset?.id,
        category: asset?.category,
        location: asset?.storage_vicinity,
        serial_number: asset?.serial_number
      };
    }

    // Add strict instructions to avoid defaulting or guessing assets
    const antiLeakageAddendum = `

IMPORTANT OVERRIDES (do not ignore):
- Do NOT invent, infer, or reuse any asset from prior context or examples.
- Only include an "asset" field in the output if actionContext.asset is present.
- If actionContext.asset is not present, OMIT the "asset" field entirely (do not write "unspecified").
- If present, the asset name MUST exactly match actionContext.asset.name.
`;

    return `${selectedPrompt.prompt_text}${antiLeakageAddendum}\n\n${JSON.stringify(actionContext, null, 2)}`;
  };

  const handleCopyPrompt = () => {
    const prompt = generatePrompt();
    navigator.clipboard.writeText(prompt);
    toast({
      title: "Copied to clipboard",
      description: "The scoring prompt has been copied to your clipboard."
    });
  };

  const handleParseResponse = () => {
    try {
      const parsed = JSON.parse(aiResponse);
      
      setParsedScores(parsed.scores || {});
      setRootCauses(parsed.likely_root_causes || []);
      setShowScoreForm(true); // Show the form after parsing
      
      
      toast({
        title: "Response parsed successfully",
        description: "You can now review and adjust the scores."
      });
    } catch (error) {
      console.error('Parse error:', error);
      toast({
        title: "Invalid JSON",
        description: "Please check your AI response format.",
        variant: "destructive"
      });
    }
  };

  const handleAutoScore = async () => {
    if (!selectedPromptId) {
      toast({
        title: "No prompt selected",
        description: "Please select a scoring prompt first.",
        variant: "destructive"
      });
      return;
    }

    setIsAutoScoring(true);
    try {
      // Generate the full prompt on the frontend
      const fullPrompt = generatePrompt();
      
      const response = await apiService.post('/analysis/generate', {
        prompt: fullPrompt,  // Send the complete prompt text
        model: selectedModel,
        auto_save: false
      });

      if (response.success && response.data) {
        // Populate the AI response field with raw text
        const aiResponseText = typeof response.data.ai_response === 'string' 
          ? response.data.ai_response 
          : JSON.stringify(response.data.ai_response, null, 2);
        
        setAiResponse(aiResponseText);
        
        // Automatically parse the response
        try {
          const parsed = JSON.parse(aiResponseText);
          setParsedScores(parsed.scores || {});
          setRootCauses(parsed.likely_root_causes || []);
          setShowScoreForm(true);
          
          // Scroll to the score card after a brief delay
          setTimeout(() => {
            scoreCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 100);
          
          toast({
            title: "Auto-scoring complete",
            description: `Scores generated and parsed successfully using ${selectedModel === 'haiku' ? 'Claude 3.5 Haiku' : 'Claude 3.5 Sonnet'}.`
          });
        } catch (parseError) {
          toast({
            title: "Auto-scoring complete",
            description: `Response generated but couldn't auto-parse. Please review and parse manually.`,
            variant: "destructive"
          });
        }
      }
    } catch (error: any) {
      console.error('Auto-scoring error:', error);
      const errorMessage = error?.response?.data?.message || error?.message || "Failed to generate scores. Please try again.";
      toast({
        title: "Auto-scoring failed",
        description: errorMessage,
        variant: "destructive"
      });
    } finally {
      setIsAutoScoring(false);
    }
  };

  const handleSaveScore = async (finalScores: Record<string, { score: number; reason: string }>) => {
    if (!selectedPrompt) return;

    try {
      const scoresArray = Object.entries(finalScores).map(([score_name, { score, reason }]) => ({
        score_name,
        score,
        reason,
        how_to_improve: ''
      }));

      const scoreData = {
        action_id: action.id!,
        prompt_id: selectedPromptId,
        scores: scoresArray,
        ai_response: aiResponse ? JSON.parse(aiResponse) : undefined,
        attributes: rootCauses.length > 0 ? [{ attribute_name: 'likely_root_cause', attribute_values: rootCauses }] : undefined,
      };

      await createScore(scoreData);
      onScoreUpdated();
      handleClose();
    } catch (error) {
      console.error('Error saving score:', error);
      toast({
        title: "Error",
        description: "Failed to save action score. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleClose = () => {
    setSelectedPromptId("");
    setAiResponse("");
    setParsedScores(null);
    setRootCauses([]);
    setIsEditMode(false);
    setShowScoreForm(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {existingScore ? "Edit Action Score" : "Score Action Performance"}
          </DialogTitle>
          <DialogDescription>
            {existingScore
              ? `Review and edit existing AI scoring for action: ${action.title}`
              : `Generate AI scoring for action: ${action.title}`
            }
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Asset Information - only show if asset exists */}
          {asset && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Asset Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-semibold">Asset Name</Label>
                    <p>{assetName}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-semibold">Category</Label>
                    <p>{asset.category || 'Uncategorized'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-semibold">Location</Label>
                    <p>{asset.storage_vicinity || 'Not specified'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-semibold">Serial Number</Label>
                    <p>{asset.serial_number || 'Not specified'}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Action Information */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Action Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Badge variant={action.status === 'completed' ? 'default' : 'outline'}>
                    {action.status === 'completed' && <CheckCircle className="w-3 h-3 mr-1" />}
                    {action.status === 'in_progress' && <Clock className="w-3 h-3 mr-1" />}
                    {action.status}
                  </Badge>
                  {action.assignee && (
                    <div className="flex items-center gap-1 text-sm text-muted-foreground">
                      <User className="h-3 w-3" />
                      {action.assignee.full_name}
                    </div>
                  )}
                </div>
                <div>
                  <Label className="text-sm font-semibold">Title</Label>
                  <p className="text-sm mt-1">{action.title}</p>
                </div>
                {action.description && (
                  <div>
                    <Label className="text-sm font-semibold">Description</Label>
                    <p className="text-sm mt-1">{action.description}</p>
                  </div>
                )}
                {action.policy && (
                  <div>
                    <Label className="text-sm font-semibold">Policy</Label>
                    <p className="text-sm mt-1">{stripHtml(action.policy)}</p>
                  </div>
                )}
                {(aggregatedObservations || action.observations) && (
                  <div>
                    <Label className="text-sm font-semibold">Observations</Label>
                    <p className="text-sm mt-1 whitespace-pre-wrap">{aggregatedObservations || stripHtml(action.observations)}</p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-semibold">Created</Label>
                    <p className="text-sm mt-1">{new Date(action.created_at).toLocaleDateString()}</p>
                  </div>
                  {action.completed_at && (
                    <div>
                      <Label className="text-sm font-semibold">Completed</Label>
                      <p className="text-sm mt-1">{new Date(action.completed_at).toLocaleDateString()}</p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Show existing score if in edit mode */}
          {isEditMode && existingScore && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Current Score</CardTitle>
              </CardHeader>
              <CardContent>
                <ScoreDisplayCard scores={[existingScore]} assetName={assetName} />
              </CardContent>
            </Card>
          )}

          {/* Scoring Prompt Selection */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="prompt-select">Select Scoring Prompt</Label>
              <Select value={selectedPromptId} onValueChange={setSelectedPromptId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a scoring prompt..." />
                </SelectTrigger>
                <SelectContent>
                  {prompts.map((prompt: any) => (
                    <SelectItem key={prompt.id} value={prompt.id}>
                      {prompt.name} {prompt.is_default && '(Default)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Generated Prompt Display */}
            {selectedPrompt && (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">AI Prompt with Action Context</CardTitle>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={handleCopyPrompt}
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copy to Clipboard
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="bg-muted p-4 rounded-lg max-h-64 overflow-y-auto">
                    <pre className="text-xs whitespace-pre-wrap font-mono">
                      {generatePrompt()}
                    </pre>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Auto-Score Section */}
          <Card className="bg-muted/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="w-4 h-4" />
                Auto-Score with AI
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="haiku">
                      Claude 3.5 Haiku (~$0.0012 per score)
                    </SelectItem>
                    <SelectItem value="sonnet">
                      Claude 3.5 Sonnet (~$0.012 per score)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button 
                  onClick={handleAutoScore}
                  disabled={!selectedPromptId || isAutoScoring}
                  variant="secondary"
                  className="whitespace-nowrap"
                >
                  {isAutoScoring ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Generate Scores
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* AI Response Input */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="ai-response">AI Response (JSON format)</Label>
              <Textarea
                id="ai-response"
                value={aiResponse}
                onChange={(e) => setAiResponse(e.target.value)}
                placeholder="Auto-generated response will appear here, or paste manually..."
                rows={8}
                className="font-mono text-sm"
              />
            </div>
            
            <div className="flex space-x-2">
              <Button 
                onClick={handleParseResponse}
                disabled={!aiResponse.trim()}
              >
                Parse & Review Scores
              </Button>
            </div>
          </div>

          {/* Score Entry Form */}
          {showScoreForm && parsedScores && (
            <Card ref={scoreCardRef}>
              <CardHeader>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">Review & Save Scores</CardTitle>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">
                        {(() => {
                          const scores = Object.values(parsedScores);
                          const mean = scores.length > 0 ? scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length : 0;
                          if (mean >= 2) return <span className="animate-bounce">🦄</span>;
                          if (mean >= 1.5) return <span className="animate-pulse">🎉</span>;
                          if (mean >= 1.2) return <span className="animate-pulse">😊</span>;
                          if (mean >= 0.8) return <span>🙂</span>;
                          return <span className="animate-[shake_0.5s_ease-in-out]">😰</span>;
                        })()}
                      </span>
                      <Badge className={`${(() => {
                        const scores = Object.values(parsedScores);
                        const mean = scores.length > 0 ? scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length : 0;
                        if (mean >= 1) return 'bg-green-100 text-green-800';
                        if (mean <= -1) return 'bg-red-100 text-red-800';
                        return 'bg-yellow-100 text-yellow-800';
                      })()} text-base px-3 py-1`}>
                        Mean: {(() => {
                          const scores = Object.values(parsedScores);
                          return scores.length > 0 ? (scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length).toFixed(2) : '0.00';
                        })()}
                      </Badge>
                    </div>
                  </div>
                  {/* Progress Bar */}
                  <div className="relative h-3 bg-gray-200 rounded-full overflow-hidden">
                    <div className="absolute inset-0 flex">
                      <div className="w-1/2 bg-red-100"></div>
                      <div className="w-1/2 bg-gradient-to-r from-yellow-100 via-green-100 to-green-200"></div>
                    </div>
                    <div 
                      className="absolute h-full bg-gradient-to-r from-green-400 to-green-500 rounded-full animate-[fillBar_1.5s_ease-out_0.5s_forwards]"
                      style={{
                        '--target-width': `${(() => {
                          const scores = Object.values(parsedScores);
                          const mean = scores.length > 0 ? scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length : 0;
                          return ((mean + 2) / 4) * 100;
                        })()}%`
                      } as React.CSSProperties}
                    ></div>
                    <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-gray-400"></div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ScoreEntryForm
                  initialScores={parsedScores}
                  rootCauses={rootCauses}
                  onSave={handleSaveScore}
                  onCancel={handleClose}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}