import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
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
import { ArrowLeft, Loader2, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useCreateFinancialRecord } from '@/hooks/useFinancialRecords';
import { useToast } from '@/components/ui/use-toast';
import { useAuth } from '@/hooks/useCognitoAuth';
import { StockSelector } from '@/components/StockSelector';
import { processStockAdjustment } from '@/lib/utils';
import {
  PhotoUploadPanel,
  type PhotoItem,
} from '@/components/shared/PhotoUploadPanel';

interface SelectedStockItem {
  part_id: string;
  quantity: number;
  part_name: string;
}

export default function RecordFinancialRecord() {
  const navigate = useNavigate();
  const { uploadFiles, isUploading } = useFileUpload();
  const createRecord = useCreateFinancialRecord();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'SCash' | 'GCash' | 'Wise'>('Cash');
  const [selectedStock, setSelectedStock] = useState<SelectedStockItem[]>([]);
  const [transactionDate, setTransactionDate] = useState<string>(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });
  const [isSaving, setIsSaving] = useState(false);

  const handleEagerUpload = useCallback(async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  }, [uploadFiles]);

  const parsedAmount = parseFloat(amount);
  const isAmountValid = amount.trim() !== '' && !isNaN(parsedAmount);
  const isDescriptionValid = description.trim().length > 0;

  const canSave =
    isAmountValid &&
    isDescriptionValid &&
    !isSaving &&
    !isUploading &&
    !photos.some(p => p.isUploading);

  const handleSave = async () => {
    if (!canSave) return;

    setIsSaving(true);

    try {
      // Upload new photos that have files but no photo_url yet
      const photosToUpload = photos.filter((p) => p.file && !p.photo_url);
      const existingPhotos = photos.filter((p) => p.photo_url && !p.file);

      let uploadedPhotos: { photo_url: string; photo_description?: string; photo_order: number }[] =
        existingPhotos.map((p) => ({
          photo_url: p.photo_url!,
          photo_description: p.photo_description || undefined,
          photo_order: p.photo_order,
        }));

      if (photosToUpload.length > 0) {
        const files = photosToUpload.map((p) => p.file!);
        const results = await uploadFiles(files, { bucket: 'mission-attachments' });
        const resultsArray = Array.isArray(results) ? results : [results];

        const newUploaded = resultsArray.map((result, index) => ({
          photo_url: result.url,
          photo_description: photosToUpload[index].photo_description || undefined,
          photo_order: existingPhotos.length + index,
        }));

        uploadedPhotos = [...uploadedPhotos, ...newUploaded];
      }

      // Reindex photo_order
      uploadedPhotos = uploadedPhotos.map((p, i) => ({ ...p, photo_order: i }));

      await createRecord.mutateAsync({
        transaction_date: transactionDate,
        description: description.trim(),
        amount: parsedAmount,
        payment_method: paymentMethod,
        photos: uploadedPhotos.length > 0 ? uploadedPhotos.map((p, i) => ({
          photo_url: p.photo_url,
          photo_description: p.photo_description,
          photo_order: i,
        })) : undefined,
      });

      if (selectedStock.length > 0) {
        try {
          await processStockAdjustment(
            selectedStock,
            user?.id || '',
            `transaction: ${description.trim()}`,
            queryClient
          );
        } catch (stockError) {
          console.error('Failed to adjust stock for transaction:', stockError);
          toast({
            title: 'Stock update failed',
            description: 'The transaction was saved, but the stock adjustment failed. Please update stock manually.',
            variant: 'destructive',
          });
        }
      }

      toast({
        title: 'Transaction saved',
        description: 'Your financial record has been saved successfully.',
      });

      navigate('/finances');
    } catch (error) {
      console.error('Failed to save financial record:', error);
      toast({
        title: 'Error',
        description: 'Failed to save transaction. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Record Transaction</h1>
          <p className="text-sm text-muted-foreground">Please upload a receipt and evidence of the purchase</p>
        </div>
      </div>

      {/* Transaction Form */}
      <Card>
        <CardContent className="pt-6 space-y-6">
          {/* Hero: Amount — large and prominent */}
          <div className="space-y-2">
            <Label htmlFor="amount" className="text-sm text-muted-foreground">Amount</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              placeholder="₱0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="text-3xl h-14 font-semibold"
              disabled={isSaving}
            />
            <p className="text-xs text-muted-foreground">Use negative for reloads or income</p>
          </div>

          {/* Core fields: Method + Date — stacked, labels above */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="payment-method" className="text-sm text-muted-foreground">Payment Method</Label>
              <Select
                value={paymentMethod}
                onValueChange={(val) => setPaymentMethod(val as 'Cash' | 'SCash' | 'GCash' | 'Wise')}
                disabled={isSaving}
              >
                <SelectTrigger id="payment-method">
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
              <Label htmlFor="transaction-date" className="text-sm text-muted-foreground">Transaction Date</Label>
              <Input
                id="transaction-date"
                type="date"
                value={transactionDate}
                onChange={(e) => setTransactionDate(e.target.value)}
                disabled={isSaving}
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description" className="text-sm text-muted-foreground">Description</Label>
            <Textarea
              id="description"
              placeholder="What was purchased or received?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              disabled={isSaving}
            />
          </div>

          {/* Optional stock adjustment — e.g. selling or buying inventory */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label className="text-sm text-muted-foreground">Adjust Stock</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      If this transaction involved inventory, record the change here. Enter a
                      positive quantity to remove stock (e.g. a sale), or negative to add stock
                      (e.g. a purchase).
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <StockSelector
              selectedStock={selectedStock}
              onStockChange={setSelectedStock}
            />
          </div>

          {/* Photos — evidence, secondary to core data */}
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Receipt & Evidence</Label>
            <PhotoUploadPanel
              photos={photos}
              onPhotosChange={setPhotos}
              onEagerUpload={handleEagerUpload}
              disabled={isSaving}
            />
          </div>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex gap-2 justify-end mt-4">
        <Button variant="outline" onClick={() => navigate(-1)} disabled={isSaving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!canSave}>
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            'Save Transaction'
          )}
        </Button>
      </div>
    </div>
  );
}
