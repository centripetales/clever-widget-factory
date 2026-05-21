import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { ArrowLeft, Loader2, Pencil, Trash2, X, Save } from 'lucide-react';
import { useAuth } from '@/hooks/useCognitoAuth';
import {
  useFinancialRecord,
  useUpdateFinancialRecord,
  useDeleteFinancialRecord,
} from '@/hooks/useFinancialRecords';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useToast } from '@/components/ui/use-toast';
import {
  PhotoUploadPanel,
  type PhotoItem,
} from '@/components/shared/PhotoUploadPanel';
import { getImageUrl, getThumbnailUrl, getOriginalUrl } from '@/lib/imageUtils';
import type { FinancialRecordEdit } from '@/types/financialRecords';

export default function FinancialRecordDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, isLeadership } = useAuth();
  const { toast } = useToast();
  const { uploadFiles, isUploading } = useFileUpload();

  const handleEagerUpload = useCallback(async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  }, [uploadFiles]);

  const { data: record, isLoading, error } = useFinancialRecord(id || '');
  const updateRecord = useUpdateFinancialRecord();
  const deleteRecord = useDeleteFinancialRecord();

  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Edit form state
  const [editAmount, setEditAmount] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPaymentMethod, setEditPaymentMethod] = useState<'Cash' | 'SCash' | 'GCash' | 'Wise'>('Cash');
  const [editTransactionDate, setEditTransactionDate] = useState('');
  const [editPhotos, setEditPhotos] = useState<PhotoItem[]>([]);

  // Determine permissions
  const isOwner = record && user && record.created_by ? record.created_by === user.id : false;
  // isLeadership maps to admin or leadership role which has data:write:org on the backend
  // null created_by records → only leadership can edit/delete
  const canEdit = isOwner || isLeadership;
  const canDelete = canEdit;

  // Populate edit form when entering edit mode
  useEffect(() => {
    if (isEditing && record) {
      setEditAmount(String(record.amount));
      setEditDescription(record.description || '');
      setEditPaymentMethod(record.payment_method);
      setEditTransactionDate(record.transaction_date.split('T')[0]);
      setEditPhotos(
        (record.photos || []).map((p, i) => ({
          id: `existing-${i}`,
          photo_url: p.photo_url,
          photo_type: 'receipt',
          photo_order: p.photo_order || i,
          isExisting: true,
          previewUrl: getImageUrl(p.photo_url) || p.photo_url,
        }))
      );
    }
  }, [isEditing, record]);

  const parsedAmount = parseFloat(editAmount);
  const isAmountValid = editAmount.trim() !== '' && !isNaN(parsedAmount);
  const isDescriptionValid = editDescription.trim().length > 0;

  const canSave =
    isAmountValid &&
    isDescriptionValid &&
    !isSaving &&
    !isUploading;

  const handleStartEdit = () => setIsEditing(true);
  const handleCancelEdit = () => setIsEditing(false);

  const handleSave = async () => {
    if (!canSave || !id || !record) return;
    setIsSaving(true);

    try {
      // Upload new photos that have files but no photo_url yet
      const photosToUpload = editPhotos.filter((p) => p.file && !p.photo_url);
      const existingPhotos = editPhotos.filter((p) => p.photo_url && !p.file);

      let uploadedPhotos: { photo_url: string; photo_type: string; photo_order: number }[] =
        existingPhotos.map((p) => ({
          photo_url: p.photo_url!,
          photo_type: p.photo_type || 'receipt',
          photo_order: p.photo_order,
        }));

      if (photosToUpload.length > 0) {
        const files = photosToUpload.map((p) => p.file!);
        const results = await uploadFiles(files, { bucket: 'mission-attachments' });
        const resultsArray = Array.isArray(results) ? results : [results];

        const newUploaded = resultsArray.map((result, index) => ({
          photo_url: result.url,
          photo_type: photosToUpload[index].photo_type || 'receipt',
          photo_order: existingPhotos.length + index,
        }));

        uploadedPhotos = [...uploadedPhotos, ...newUploaded];
      }

      // Reindex photo_order
      uploadedPhotos = uploadedPhotos.map((p, i) => ({ ...p, photo_order: i }));

      await updateRecord.mutateAsync({
        id,
        data: {
          transaction_date: editTransactionDate,
          description: editDescription.trim(),
          amount: parsedAmount,
          payment_method: editPaymentMethod,
          photos: uploadedPhotos.length > 0 ? uploadedPhotos.map((p, i) => ({
            photo_url: p.photo_url,
            photo_description: undefined,
            photo_order: i,
          })) : undefined,
        },
      });

      toast({
        title: 'Transaction updated',
        description: 'Your changes have been saved.',
      });
      setIsEditing(false);
    } catch (err) {
      console.error('Failed to update financial record:', err);
      toast({
        title: 'Error',
        description: 'Failed to save changes. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    try {
      await deleteRecord.mutateAsync(id);
      toast({
        title: 'Transaction deleted',
        description: 'The financial record has been removed.',
      });
      navigate('/finances');
    } catch (err) {
      console.error('Failed to delete financial record:', err);
      toast({
        title: 'Error',
        description: 'Failed to delete transaction. Please try again.',
        variant: 'destructive',
      });
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="container mx-auto p-4 max-w-6xl flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // 404 state
  if (error || !record) {
    return (
      <div className="container mx-auto p-4 max-w-6xl">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-2xl font-bold">Record Not Found</h1>
        </div>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              This financial record doesn't exist or you don't have permission to view it.
            </p>
            <Button className="mt-4" onClick={() => navigate('/')}>
              Back to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const recordWithEdits = record as typeof record & { edits?: FinancialRecordEdit[] };
  const edits: FinancialRecordEdit[] = recordWithEdits.edits || [];

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-2xl font-bold">Transaction Detail</h1>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && !isEditing && (
            <Button variant="outline" size="sm" onClick={handleStartEdit}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}
          {isEditing && (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancelEdit} disabled={isSaving}>
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!canSave}>
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4 mr-2" />
                    Save
                  </>
                )}
              </Button>
            </>
          )}
          {canDelete && !isEditing && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Transaction</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete this financial record and all associated edit history.
                    This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Photos Section */}
      <Card>
        <CardHeader>
          <CardTitle>Photos</CardTitle>
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <PhotoUploadPanel
              photos={editPhotos}
              onPhotosChange={setEditPhotos}
              onEagerUpload={handleEagerUpload}
              disabled={isSaving}
            />
          ) : (
            <div className="space-y-2">
              {!record.photos || record.photos.length === 0 ? (
                <p className="text-sm text-muted-foreground">No photos attached</p>
              ) : (
                <div className="flex flex-col md:flex-row gap-6 items-stretch">
                  {/* Left Column: Photo list/grid */}
                  <div className={`grid gap-3 ${record.photos.length === 1 ? 'w-full md:w-1/3 max-w-[240px]' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 flex-1'}`}>
                    {(record.photos || [])
                      .sort((a, b) => a.photo_order - b.photo_order)
                      .map((photo, index) => (
                        <div key={index} className="flex flex-col">
                          <div className="relative group/img-container">
                            <img
                              src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || photo.photo_url}
                              alt={(photo as any).photo_description || `photo ${index + 1}`}
                              className="w-full aspect-square object-cover rounded border cursor-pointer hover:opacity-80 transition-opacity"
                              onClick={() => window.open(getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || photo.photo_url, '_blank')}
                              onError={(e) => {
                                const originalUrl = getImageUrl(photo.photo_url);
                                if (originalUrl && e.currentTarget.src !== originalUrl) {
                                  e.currentTarget.src = originalUrl;
                                } else {
                                  e.currentTarget.style.display = 'none';
                                }
                              }}
                            />
                            {photo.transcription?.trim() && (
                              <div className="absolute top-1 left-1 z-20">
                                <span className="relative group/ai cursor-help inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-zinc-900/85 text-zinc-100 border border-zinc-700/50 hover:bg-zinc-800 transition-all select-none">
                                  <span>AI</span>
                                  <span className="absolute left-0 top-full mt-1.5 w-[280px] xs:w-[340px] p-3 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg shadow-2xl hidden group-hover/ai:block z-30 normal-case not-italic text-xs text-zinc-700 dark:text-zinc-350 leading-normal text-left font-normal">
                                    <span className="block font-semibold text-zinc-900 dark:text-white mb-0.5">AI Description:</span>
                                    <span className="block bg-indigo-50/30 dark:bg-indigo-950/15 p-2 rounded text-zinc-800 dark:text-zinc-200 leading-relaxed text-xs border border-indigo-100/50 dark:border-indigo-900/20 text-left font-normal">
                                      {photo.transcription.replace(/^\[photo_analysis\]\s*/, '')}
                                    </span>
                                  </span>
                                </span>
                              </div>
                            )}
                          </div>
                          {(photo as any).photo_description && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{(photo as any).photo_description}</p>
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transaction Details */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Transaction Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isEditing ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="edit-amount">Total Cost</Label>
                <Input
                  id="edit-amount"
                  type="number"
                  step="0.01"
                  placeholder="Enter amount (negative for reloads)"
                  value={editAmount}
                  onChange={(e) => setEditAmount(e.target.value)}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-description">Description</Label>
                <Textarea
                  id="edit-description"
                  placeholder="What was purchased or received?"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-payment-method">Payment Method</Label>
                <Select
                  value={editPaymentMethod}
                  onValueChange={(val) => setEditPaymentMethod(val as 'Cash' | 'SCash' | 'GCash' | 'Wise')}
                  disabled={isSaving}
                >
                  <SelectTrigger id="edit-payment-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Cash">Cash</SelectItem>
                    <SelectItem value="SCash">SCash</SelectItem>
                    <SelectItem value="GCash">GCash</SelectItem>
                    <SelectItem value="Wise">Wise</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-transaction-date">Transaction Date</Label>
                <Input
                  id="edit-transaction-date"
                  type="date"
                  value={editTransactionDate}
                  onChange={(e) => setEditTransactionDate(e.target.value)}
                  disabled={isSaving}
                />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Amount</p>
                <p className="text-lg font-semibold">
                  {record.amount < 0 ? '-' : ''}₱{Math.abs(record.amount).toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Transaction Date</p>
                <p className="font-medium">{new Date(record.transaction_date).toLocaleDateString()}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-sm text-muted-foreground">Description</p>
                <p className="font-medium">{record.description}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Payment Method</p>
                <Badge variant="outline">{record.payment_method}</Badge>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Metadata */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Record Info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Created By</p>
              <p className="font-medium">{record.created_by_name || 'Unknown'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Created At</p>
              <p className="font-medium">{new Date(record.created_at).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Last Updated</p>
              <p className="font-medium">{new Date(record.updated_at).toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Edit History */}
      {edits.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Edit History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {edits.map((edit) => (
                <div
                  key={edit.id}
                  className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 border-b pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(edit.edited_at).toLocaleString()}
                  </div>
                  <div className="flex-1 text-sm">
                    <span className="font-medium">{edit.edited_by_name || edit.edited_by}</span>
                    {' changed '}
                    <Badge variant="outline" className="text-xs">
                      {edit.field_changed}
                    </Badge>
                    {edit.old_value != null && (
                      <>
                        {' from '}
                        <span className="text-muted-foreground line-through">{edit.old_value}</span>
                      </>
                    )}
                    {edit.new_value != null && (
                      <>
                        {' to '}
                        <span className="font-medium">{edit.new_value}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
