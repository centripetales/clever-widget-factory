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
import { ArrowLeft, Loader2, Pencil, Trash2, X, Save, ScanText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { financialRecordsService, type ExtractedReading } from '@/services/financialRecordsService';
import { apiService } from '@/lib/apiService';
import { snapshotService } from '@/services/snapshotService';
import { financialRecordKeys } from '@/hooks/useFinancialRecords';
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
import { getImageUrl, getThumbnailUrl, openImage } from '@/lib/imageUtils';
import { TransactionRewards } from '@/components/positiveSum/TransactionRewards';
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

  // Purchases read from the photos, held for the person to confirm
  const queryClient = useQueryClient();
  const [isExtracting, setIsExtracting] = useState(false);
  const [reading, setReading] = useState<ExtractedReading | null>(null);
  const extracted = reading?.purchases ?? null;

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
          photo_description: p.photo_description || '',
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

      let uploadedPhotos: { photo_url: string; photo_type: string; photo_description: string; photo_order: number }[] =
        existingPhotos.map((p) => ({
          photo_url: p.photo_url!,
          photo_type: p.photo_type || 'receipt',
          photo_description: p.photo_description || '',
          photo_order: p.photo_order,
        }));

      if (photosToUpload.length > 0) {
        const files = photosToUpload.map((p) => p.file!);
        const results = await uploadFiles(files, { bucket: 'mission-attachments' });
        const resultsArray = Array.isArray(results) ? results : [results];

        const newUploaded = resultsArray.map((result, index) => ({
          photo_url: result.url,
          photo_type: photosToUpload[index].photo_type || 'receipt',
          photo_description: photosToUpload[index].photo_description || '',
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
            photo_description: p.photo_description,
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

  const handleExtract = async () => {
    if (!id) return;
    setIsExtracting(true);
    try {
      setReading(await financialRecordsService.extractPurchases(id));
    } catch (err) {
      console.error('Failed to read purchases from photos:', err);
      toast({
        title: 'Could not read the photos',
        description: 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsExtracting(false);
    }
  };

  // The policies the expense follows are linked to its action, and one note records what was observed in
  // the photos: the fuel fill's readings (on the vehicle) and what each policy asks for that was not observed
  const saveReading = async (result: ExtractedReading, recordId: string, actionId: string | null | undefined, transactionDate: string) => {
    const { fuel, policies } = result;
    if (actionId && policies.length > 0) {
      const followed = await financialRecordsService.getActionPolicyIds(actionId);
      await financialRecordsService.setActionPolicyIds(actionId, [...new Set([...followed, ...policies.map((policy) => policy.id)])]);
    }
    if (!fuel && policies.length === 0) return;

    const seen = (label: string, observed: boolean, detail?: string) =>
      `${label}: ${observed ? ['Observed', detail].filter(Boolean).join(', ') : 'Not observed'}`;
    const lines = ['Read from the photos by Bedrock. What was observed, not a judgement:'];
    if (fuel) {
      lines.push(
        seen(`${fuel.machine.meter_name} photo`, fuel.observed.meter_photo, fuel.meter_reading !== null ? `${fuel.meter_reading} ${fuel.machine.meter_unit}` : undefined),
        seen('Pump photo', fuel.observed.pump_photo, [fuel.liters !== null ? `${fuel.liters} L` : '', fuel.octane ? `octane ${fuel.octane}` : ''].filter(Boolean).join(', ')),
        seen('Receipt photo', fuel.observed.receipt_photo),
        seen('Full tank', fuel.observed.full_tank),
      );
    }
    for (const policy of policies) {
      lines.push(`Policy "${policy.title}": ${policy.not_observed.length > 0 ? `not observed: ${policy.not_observed.join(', ')}` : 'everything it asks for was observed'}`);
    }
    const created = await apiService.post<{ data: { id: string } }>('/states', {
      state_text: lines.join('\n'),
      photos: [],
      captured_at: transactionDate,
      links: [
        ...(fuel ? [{ entity_type: 'tool', entity_id: fuel.machine.id }] : []),
        { entity_type: 'financial_record', entity_id: recordId },
      ],
    });
    const stateId = created?.data?.id;
    if (!stateId || !fuel) return;
    // Only the raw readings are saved: km/l is worked out from them, not a reading of its own
    if (fuel.meter_reading !== null) {
      await snapshotService.createSnapshot(stateId, { metric_id: fuel.machine.meter_metric_id, value: String(fuel.meter_reading) });
    }
    if (fuel.liters !== null && fuel.machine.fuel_metric_id) {
      await snapshotService.createSnapshot(stateId, { metric_id: fuel.machine.fuel_metric_id, value: String(fuel.liters) });
    }
  };

  const handleSaveExtracted = async () => {
    if (!id || !extracted) return;
    setIsSaving(true);
    try {
      await financialRecordsService.savePurchases(id, extracted);
      if (reading && record) await saveReading(reading, id, record.action_id, record.transaction_date);
      await queryClient.invalidateQueries({ queryKey: financialRecordKeys.detail(id) });
      setReading(null);
      toast({ title: 'Purchases saved' });
    } catch (err) {
      console.error('Failed to save purchases:', err);
      toast({
        title: 'Error',
        description: 'Failed to save purchases. Please try again.',
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
            <div className="space-y-4">
              {!record.photos || record.photos.length === 0 ? (
                <p className="text-sm text-muted-foreground">No photos attached</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {(record.photos || [])
                    .sort((a, b) => a.photo_order - b.photo_order)
                    .map((photo, index) => (
                      <div key={photo.id || index} className="flex flex-col sm:flex-row gap-4 p-3 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50">
                        {/* Left part: Image/thumbnail */}
                        <div className="relative w-40 h-40 flex-shrink-0 mx-auto sm:mx-0">
                          <img
                            src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || photo.photo_url}
                            alt={(photo as any).photo_description || `photo ${index + 1}`}
                            className="w-full h-full object-cover rounded border cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={() => openImage(photo.photo_url)}
                            onError={(e) => {
                              const originalUrl = getImageUrl(photo.photo_url);
                              if (originalUrl && e.currentTarget.src !== originalUrl) {
                                e.currentTarget.src = originalUrl;
                              } else {
                                e.currentTarget.style.display = 'none';
                              }
                            }}
                          />
                        </div>

                        {/* Right part: the person's description of the photo */}
                        <div className="flex-1 flex flex-col justify-start min-w-0">
                          {photo.photo_description?.trim() ? (
                            <div className="p-3 rounded bg-zinc-100/50 dark:bg-zinc-800/20 border border-zinc-200/50 dark:border-zinc-750/30 h-full">
                              <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed font-normal whitespace-pre-wrap">
                                {photo.photo_description}
                              </p>
                            </div>
                          ) : (
                            <div className="p-3 rounded bg-zinc-100/50 dark:bg-zinc-800/20 border border-zinc-200/50 dark:border-zinc-750/30 h-full flex items-center justify-center">
                              <p className="text-xs text-muted-foreground italic">No description.</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
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
              {record.vendor && (
                <div>
                  <p className="text-sm text-muted-foreground">Vendor</p>
                  <p className="font-medium">{record.vendor.name}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Purchases: the actual prices paid, saved through Claude from the receipt */}
      {!isEditing && record.purchases && record.purchases.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Purchases</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {record.purchases.map((purchase) => (
              <div key={purchase.id} className="flex items-start justify-between gap-4 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{purchase.purchase_text}</p>
                  <p className="text-muted-foreground">
                    {purchase.quantity !== null && `${Number(purchase.quantity)}${purchase.unit ? ` ${purchase.unit}` : ''}`}
                    {purchase.unit_price !== null && ` at ₱${Number(purchase.unit_price).toFixed(2)}`}
                    {purchase.part_name && ` · ${purchase.part_name}`}
                  </p>
                </div>
                <p className="font-medium whitespace-nowrap">₱{Number(purchase.amount).toFixed(2)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Read purchases from the photos (only when none are saved yet), confirmed before saving */}
      {!isEditing && canEdit && (!record.purchases || record.purchases.length === 0) && record.photos && record.photos.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Purchases</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {reading === null || extracted === null ? (
              <Button variant="outline" size="sm" onClick={handleExtract} disabled={isExtracting}>
                {isExtracting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ScanText className="h-4 w-4 mr-2" />
                )}
                {isExtracting ? 'Reading photos...' : 'Read purchases from photos'}
              </Button>
            ) : (
              <>
                {extracted.length === 0 && (
                  <p className="text-sm text-muted-foreground">No purchases could be read from the photos.</p>
                )}
                {extracted.map((purchase, index) => (
                  <div key={index} className="flex items-start justify-between gap-4 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium">{purchase.purchase_text}</p>
                      <p className="text-muted-foreground">
                        {purchase.quantity !== null && `${purchase.quantity}${purchase.unit ? ` ${purchase.unit}` : ''}`}
                        {purchase.unit_price !== null && ` at ₱${purchase.unit_price.toFixed(2)}`}
                      </p>
                    </div>
                    <p className="font-medium whitespace-nowrap">₱{purchase.amount.toFixed(2)}</p>
                  </div>
                ))}
                {reading?.fuel && (
                  <div className="rounded border p-3 text-sm space-y-1">
                    <p className="font-medium">Fuel fill: {reading.fuel.machine.name}</p>
                    <p>
                      {reading.fuel.meter_reading !== null ? `${reading.fuel.meter_reading} ${reading.fuel.machine.meter_unit}` : `${reading.fuel.machine.meter_name} not read`}
                      {reading.fuel.liters !== null && ` · ${reading.fuel.liters} L`}
                      {reading.fuel.rate !== null && reading.fuel.previous && (
                        <> · <span className="font-medium">{reading.fuel.rate} {reading.fuel.machine.rate_unit}</span> since {reading.fuel.previous.meter_reading} {reading.fuel.machine.meter_unit} on {new Date(reading.fuel.previous.date).toLocaleDateString()}</>
                      )}
                    </p>
                    <ul className="text-muted-foreground">
                      <li>{reading.fuel.machine.meter_name} photo: {reading.fuel.observed.meter_photo ? 'Observed' : 'Not observed'}</li>
                      <li>Pump photo: {reading.fuel.observed.pump_photo ? 'Observed' : 'Not observed'}</li>
                      <li>Receipt photo: {reading.fuel.observed.receipt_photo ? 'Observed' : 'Not observed'}</li>
                      <li>Full tank: {reading.fuel.observed.full_tank ? 'Observed' : 'Not observed'}</li>
                    </ul>
                  </div>
                )}
                {reading?.policies.map((policy) => (
                  <div key={policy.id} className="rounded border p-3 text-sm">
                    <p className="font-medium">Policy: {policy.title}</p>
                    <p className="text-muted-foreground">
                      {policy.not_observed.length > 0 ? `Not observed: ${policy.not_observed.join(', ')}` : 'Everything it asks for was observed'}
                    </p>
                  </div>
                ))}
                {extracted.length > 0 && Math.abs(extracted.reduce((sum, p) => sum + p.amount, 0) - Number(record.amount)) > 0.005 && (
                  <p className="text-sm text-amber-600">
                    These add up to ₱{extracted.reduce((sum, p) => sum + p.amount, 0).toFixed(2)}, not the record's ₱{Number(record.amount).toFixed(2)}.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveExtracted} disabled={isSaving || extracted.length === 0}>
                    {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Save purchases
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setReading(null)} disabled={isSaving}>
                    Discard
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Notes: observations added after the description, e.g. what Claude found reading the receipt */}
      {!isEditing && record.notes && record.notes.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {record.notes.map((note) => (
              <div key={note.id} className="text-sm">
                <p className="whitespace-pre-wrap">{note.state_text}</p>
                <p className="text-muted-foreground mt-1">
                  {note.captured_by_name} · {new Date(note.captured_at).toLocaleDateString()}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Rewards — expenses only for now (docs/design/POSITIVE_SUM.md §2.6) */}
      {Number(record.amount) > 0 && <TransactionRewards recordId={record.id} organizationId={record.organization_id} descriptionStateId={record.state_id} />}

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
