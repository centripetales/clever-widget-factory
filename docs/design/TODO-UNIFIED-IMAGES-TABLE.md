# TODO: Unified Images Table Refactor

## Problem
Currently, images are stored inconsistently across the application:
- **parts** table: `image_url` (single string)
- **tools** table: `image_url` (single string)
- **actions** table: `attachments` (JSON array)
- **issues**: Various photo storage approaches

This makes it impossible to:
- Store multiple images per entity
- Add metadata (captions, dimensions, etc.)
- Generate embeddings for image search
- Have consistent image handling across the app

## Solution: Unified `images` Table

Create a single table that stores all images for all entity types using a polymorphic pattern.

### Schema Design

```sql
CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Polymorphic reference (works with ANY entity)
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL, -- 'tool', 'part', 'action', 'issue', 'mission', etc.
  
  -- Image storage
  image_url TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  mime_type VARCHAR(100),
  
  -- Metadata
  caption TEXT,
  alt_text TEXT,
  display_order INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT false,
  
  -- Image analysis (for future use)
  width INTEGER,
  height INTEGER,
  embedding vector(1536), -- For image embeddings (Titan dimension)
  
  -- Audit fields
  uploaded_by UUID,
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  organization_id UUID NOT NULL,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_images_entity ON images(entity_id, entity_type);
CREATE INDEX idx_images_organization ON images(organization_id);
CREATE INDEX idx_images_primary ON images(is_primary) WHERE is_primary = true;
CREATE INDEX idx_images_display_order ON images(display_order);
CREATE INDEX idx_images_embedding ON images USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

## Migration Plan

### Phase 1: Database Setup
- [ ] Create `images` table with schema above
- [ ] Migrate existing data:
  - [ ] Copy `parts.image_url` → `images` (entity_type='part')
  - [ ] Copy `tools.image_url` → `images` (entity_type='tool')
  - [ ] Parse `actions.attachments` JSON → `images` (entity_type='action')
- [ ] Keep old columns temporarily for backward compatibility

### Phase 2: Backend API
- [ ] Create Lambda function: `cwf-images-handler`
  - [ ] `GET /api/images?entity_id={id}&entity_type={type}` - List images
  - [ ] `POST /api/images` - Add image (with presigned URL)
  - [ ] `PUT /api/images/{id}` - Update metadata (caption, order)
  - [ ] `DELETE /api/images/{id}` - Delete image
  - [ ] `PUT /api/images/{id}/primary` - Set as primary image
- [ ] Add API Gateway routes with authorizer
- [ ] Update existing endpoints to return images from new table:
  - [ ] `/api/parts` - Include images array
  - [ ] `/api/tools` - Include images array
  - [ ] `/api/actions` - Include images array

### Phase 3: Frontend Updates
- [ ] Create `useEntityImages` hook:
  ```typescript
  const { images, uploadImage, deleteImage, setPrimary, isLoading } = 
    useEntityImages(entityId, entityType);
  ```
- [ ] Update `FileAttachmentManager` to use new hook
- [ ] Update components to use images array instead of single image_url:
  - [ ] `CombinedAssetsContainer` - Stock items
  - [ ] `EditToolForm` - Tool images
  - [ ] `UnifiedActionDialog` - Action attachments
  - [ ] `IssueReportDialog` - Issue photos
- [ ] Add image gallery component for viewing multiple images
- [ ] Add drag-and-drop reordering for display_order

### Phase 4: Cleanup
- [ ] Verify all entities using new images table
- [ ] Remove old columns:
  - [ ] Drop `parts.image_url`
  - [ ] Drop `tools.image_url`
  - [ ] Drop `actions.attachments`
- [ ] Remove old upload code that directly modified entity tables
- [ ] Update documentation

### Phase 5: Future Enhancements
- [ ] Generate embeddings for uploaded images
- [ ] Image similarity search across all entities
- [ ] Automatic image optimization/resizing
- [ ] OCR text extraction for searchable documents
- [ ] Image tagging and categorization

## Benefits

1. **Consistency** - One pattern for all images across the app
2. **Scalability** - Easy to add images to new entity types
3. **Rich Metadata** - Captions, dimensions, embeddings
4. **Multiple Images** - No limit on images per entity
5. **Image Search** - Search images across all entities using embeddings
6. **Simpler Code** - One component, one API, one hook

## Example Usage

### Query Images
```sql
-- Get all images for a part
SELECT * FROM images 
WHERE entity_id = 'part-uuid' AND entity_type = 'part'
ORDER BY display_order;

-- Get primary image for an action
SELECT * FROM images 
WHERE entity_id = 'action-uuid' AND entity_type = 'action' AND is_primary = true;

-- Search images across all entities
SELECT * FROM images 
WHERE organization_id = 'org-uuid'
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 10;
```

### Frontend Usage
```typescript
// In any component
const { images, uploadImage, deleteImage } = useEntityImages(partId, 'part');

// Upload
await uploadImage(file, { caption: 'Front view', isPrimary: true });

// Display
{images.map(img => (
  <img key={img.id} src={img.image_url} alt={img.alt_text} />
))}
```

## Notes

- Keep this as a **future refactor** - current workaround is to only use first image from attachments array
- Estimated effort: 2-3 days for full implementation
- Can be done incrementally (one entity type at a time)
- Backward compatible during migration (keep old columns until verified)

## Current Workaround

Until this refactor is complete, the immediate fix for stock items:
- Update `handleStockEditSubmit` to save all attachments, not just first one
- Add `attachments` column to `parts` table (JSON array)
- Or continue using single `image_url` and only allow one image per stock item
