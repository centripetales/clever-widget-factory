import React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Paperclip, X } from "lucide-react";
import { useFileUpload } from "@/hooks/useFileUpload";
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from "@/lib/imageUtils";

interface FileAttachmentManagerProps {
  attachments: string[];
  onAttachmentsChange: (attachments: string[]) => void;
  bucket: string;
  label?: string;
  disabled?: boolean;
  maxFiles?: number;
  onUploadStateChange?: (isUploading: boolean) => void;
}

export const FileAttachmentManager = ({
  attachments = [],
  onAttachmentsChange,
  bucket,
  label = "Attachments (Images & PDFs)",
  disabled = false,
  maxFiles = 10,
  onUploadStateChange
}: FileAttachmentManagerProps) => {
  const { uploadFiles, isUploading } = useFileUpload();
  
  // Notify parent of upload state changes
  React.useEffect(() => {
    onUploadStateChange?.(isUploading);
  }, [isUploading, onUploadStateChange]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    if (attachments.length + files.length > maxFiles) {
      // Show error toast
      return;
    }

    try {
      const fileArray = Array.from(files);
      const uploadResults = await uploadFiles(fileArray, { bucket });
      
      const resultsArray = Array.isArray(uploadResults) ? uploadResults : [uploadResults];
      const uploadedUrls = resultsArray.map(result => result.url);
      
      onAttachmentsChange([...attachments, ...uploadedUrls]);
    } catch (error) {
      console.error('Error uploading files:', error);
    }
  };

  const removeAttachment = (index: number) => {
    onAttachmentsChange(attachments.filter((_, i) => i !== index));
  };

  return (
    <div>
      <Label className="text-sm font-medium">{label}</Label>
      <div className="mt-1">
        <input
          type="file"
          multiple
          accept="image/*,.pdf"
          onChange={handleFileUpload}
          className="hidden"
          id="attachmentUpload"
          disabled={disabled || isUploading}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => document.getElementById('attachmentUpload')?.click()}
          disabled={disabled || isUploading}
          className="w-full"
        >
          <Paperclip className="h-4 w-4 mr-2" />
          {isUploading ? 'Uploading...' : 'Upload Images & PDFs'}
        </Button>
      </div>
      
      {/* Display uploaded attachments */}
      {attachments.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            {attachments.map((url, index) => {
              const isPdf = url.toLowerCase().endsWith('.pdf');
              return (
                <div key={index} className="relative">
                  {isPdf ? (
                    <div
                      className="h-16 w-16 flex items-center justify-center bg-muted rounded border cursor-pointer hover:bg-muted/80"
                      onClick={() => window.open(getImageUrl(url) || url, '_blank')}
                    >
                      <svg className="h-8 w-8 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                    </div>
                  ) : (
                    <img
                      src={getThumbnailUrl(url) || ''}
                      alt={`Attachment ${index + 1}`}
                      className="h-16 w-16 object-cover rounded border cursor-pointer"
                      onClick={() => window.open(getOriginalUrl(url) || getImageUrl(url) || url, '_blank')}
                      onError={(e) => {
                        // Fallback to original image if thumbnail doesn't exist yet
                        const target = e.target as HTMLImageElement;
                        const originalUrl = url.startsWith('http') ? url : `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${url}`;
                        if (target.src !== originalUrl) {
                          target.src = originalUrl;
                        }
                      }}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => removeAttachment(index)}
                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
