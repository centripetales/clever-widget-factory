/**
 * ProfileIntentsSection Component
 *
 * Manages saved growth intents on the user's profile settings.
 * Allows adding, editing, and deleting growth intent statements
 * that auto-fill into the SkillProfilePanel when generating skill profiles.
 *
 * Follows the pattern of OrganizationValuesSection.
 *
 * Requirements: 4.1, 4.2
 */

import { useState, KeyboardEvent } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Plus, Pencil, Trash2, Check, X, Info, Loader2 } from 'lucide-react';
import {
  useMemberSettings,
  useUpdateMemberSettings,
} from '@/hooks/useMemberSettings';

interface ProfileIntentsSectionProps {
  userId: string;
  organizationId: string;
}

export function ProfileIntentsSection({
  userId,
  organizationId,
}: ProfileIntentsSectionProps) {
  const { data: settings, isLoading: isLoadingSettings } = useMemberSettings(
    userId,
    organizationId
  );
  const updateMutation = useUpdateMemberSettings();

  const intents = settings?.growth_intents ?? [];

  const [newIntent, setNewIntent] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  const saveIntents = (updatedIntents: string[]) => {
    updateMutation.mutate({
      userId,
      organizationId,
      settings: { ...settings, growth_intents: updatedIntents },
    });
  };

  const handleAdd = () => {
    const trimmed = newIntent.trim();
    if (!trimmed) return;
    if (intents.includes(trimmed)) return;
    saveIntents([...intents, trimmed]);
    setNewIntent('');
  };

  const handleAddKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleDelete = (index: number) => {
    const updated = intents.filter((_, i) => i !== index);
    saveIntents(updated);
  };

  const handleEditStart = (index: number) => {
    setEditingIndex(index);
    setEditValue(intents[index]);
  };

  const handleEditSave = () => {
    if (editingIndex === null) return;
    const trimmed = editValue.trim();
    if (!trimmed) return;
    // Prevent duplicates (allow same index to keep its value)
    if (intents.some((v, i) => i !== editingIndex && v === trimmed)) return;
    const updated = intents.map((v, i) => (i === editingIndex ? trimmed : v));
    saveIntents(updated);
    setEditingIndex(null);
    setEditValue('');
  };

  const handleEditCancel = () => {
    setEditingIndex(null);
    setEditValue('');
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleEditSave();
    } else if (e.key === 'Escape') {
      handleEditCancel();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Growth Intents
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-auto p-1">
                <Info className="w-4 h-4 text-muted-foreground hover:text-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <div className="space-y-2">
                <p className="font-medium">Growth Intents</p>
                <p className="text-sm text-muted-foreground">
                  Save what you want to get better at. Your growth intents
                  auto-fill when generating skill profiles, so the learning
                  content aligns with your personal growth direction.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Loading state */}
        {isLoadingSettings && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}

        {/* Intents list */}
        {!isLoadingSettings && (
          <div className="space-y-2">
            {intents.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-2">
                No growth intents saved yet. Add one below to auto-fill when
                generating skill profiles.
              </p>
            ) : (
              intents.map((intent, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-3 border rounded-lg bg-muted/20"
                >
                  {editingIndex === index ? (
                    <>
                      <Input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        className="flex-1 text-sm"
                        autoFocus
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleEditSave}
                        disabled={!editValue.trim()}
                        className="h-8 w-8 p-0 shrink-0"
                        aria-label="Save edit"
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleEditCancel}
                        className="h-8 w-8 p-0 shrink-0"
                        aria-label="Cancel edit"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-sm">{intent}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEditStart(index)}
                        className="h-8 w-8 p-0 shrink-0"
                        aria-label={`Edit "${intent}"`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(index)}
                        className="h-8 w-8 p-0 shrink-0 text-destructive hover:text-destructive"
                        aria-label={`Delete "${intent}"`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Add new intent */}
        {!isLoadingSettings && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={newIntent}
                onChange={(e) => setNewIntent(e.target.value)}
                onKeyDown={handleAddKeyDown}
                placeholder="Add a growth intent (e.g. improve my leadership skills)"
                className="flex-1"
              />
              <Button
                onClick={handleAdd}
                disabled={
                  !newIntent.trim() ||
                  intents.includes(newIntent.trim()) ||
                  updateMutation.isPending
                }
                size="sm"
                variant="outline"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Press Enter to add. These intents auto-fill when you generate
              skill profiles.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
