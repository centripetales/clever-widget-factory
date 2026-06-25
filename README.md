# Clever Widget Factory

A comprehensive asset management and accountability system built with React, TypeScript, and AWS.

## Current Architecture (Post-Migration)

**⚠️ IMPORTANT: We are NO LONGER using Supabase. The application has been migrated to AWS infrastructure.**

### Technology Stack
- **Frontend**: React + TypeScript + Vite (runs on port 8080)
- **Backend API**: AWS API Gateway + Lambda
- **Database**: AWS RDS PostgreSQL
- **Authentication**: AWS Cognito
- **File Storage**: AWS S3
- **Infrastructure**: Fully AWS-based

## Local Development Setup

### Prerequisites
- Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

### Development Setup

1. **Clone and install**:
   ```bash
   git clone <YOUR_GIT_URL>
   cd clever-widget-factory
   npm i
   ```

2. **Start the frontend**:
   ```bash
   npm run dev
   ```
   This starts the Vite dev server on http://localhost:8080

### API Configuration

**IMPORTANT**: The `VITE_API_BASE_URL` should NOT include the `/api` suffix:
- ✅ Correct: `https://xxx.execute-api.us-west-2.amazonaws.com/prod`
- ❌ Wrong: `https://xxx.execute-api.us-west-2.amazonaws.com/prod/api`

The apiService automatically adds `/api` to all endpoints.

### API Endpoints
The AWS API Gateway provides these endpoints:
- `GET /health` - Health check
- `GET /api/actions` - Get all actions
- `POST /api/actions` - Create action
- `PUT /api/actions/{id}` - Update action
- `DELETE /api/actions/{id}` - Delete action
- `GET /api/organization_members` - Get organization members
- `GET /api/tools` - Get tools
- `GET /api/parts` - Get parts
- `POST /api/query` - Execute custom SQL queries
- `POST /api/semantic-search` - Semantic search using Bedrock embeddings

#### `/api/tools` response
Tools are served by the `cwf-core-lambda` function which queries the AWS RDS instance. Each tool row now includes checkout metadata resolved server-side (no extra checkout request required):
- `is_checked_out` (boolean)
- `checked_out_user_id`
- `checked_out_to`
- `checked_out_date`
- `expected_return_date`
- `checkout_intended_usage`
- `checkout_notes`

When a tool has an active checkout (`is_returned = false` in `checkouts`), `status` is automatically overridden to `checked_out`.

### Database Connection
- **All environments**: AWS RDS PostgreSQL instance

### Database Migrations
Run database migrations using the Lambda function:
```bash
aws lambda invoke --function-name cwf-db-migration --payload '{"sql":"YOUR_SQL_HERE"}' response.json --region us-west-2 --cli-binary-format raw-in-base64-out
```

### API Gateway Management

**Adding new endpoints:**
```bash
# Add endpoint with authorizer
./scripts/add-api-endpoint.sh /api/your-endpoint GET

### Lambda Deployment

For deploying backend Lambda updates (`lambda/core/index.js`, etc.) to AWS, two deployment scripts are provided:

#### 1. Fast Code Update (1–3 seconds)
Uses the AWS CLI to update only your handler code, completely bypassing zipping `node_modules` (since dependencies are housed in the Lambda Layer). This is the recommended loop during active backend code development:
```bash
./scripts/deploy/deploy-lambda-fast.sh <lambda-dir> <function-name>
# Example:
./scripts/deploy/deploy-lambda-fast.sh core cwf-core-lambda
```

#### 2. Full Build & Deployment (20–45 seconds)
Performs a clean production build (`npm install --production`), packages all local dependencies, updates function code, and synchronizes layers, environment variables, timeouts, and memory configurations:
```bash
./scripts/deploy/deploy-lambda-with-layer.sh <lambda-dir> <function-name>
# Example:
./scripts/deploy/deploy-lambda-with-layer.sh core cwf-core-lambda
```
*Use this script when you add new npm packages, modify package.json dependencies, or update environment variables.*

**Verify all endpoints have authorizers:**
```bash
./scripts/verify-api-authorizers.sh
```

**Important:** All API endpoints (except `/api/health` and `/api/schema`) MUST have the authorizer configured. The verification script runs weekly via GitHub Actions.

### Migration Status
✅ **COMPLETED**: Migrated from Supabase to AWS infrastructure
- Frontend updated to use API service instead of Supabase client
- Database migrated to PostgreSQL
- Authentication moved to AWS Cognito
- File storage moved to AWS S3
- Policy agreement system implemented (actions now use `policy_agreed_at`/`policy_agreed_by` fields)

### User ID Migration Reference
During Cognito migration, user IDs were updated. Reference for any remaining migrations:

| User | Old UUID | New Cognito UUID |
|------|----------|------------------|
| Malone | `4d7124f9-c0f2-490d-a765-3a3f8d1dbad8` | `989163e0-7011-70ee-6d93-853674acd43c` |
| Lester Paniel | `7dd4187f-ff2a-4367-9e7b-0c8741f25495` | `68d173b0-60f1-70ea-6084-338e74051fcc` |
| Mae Dela Torre | `48155769-4d22-4d36-9982-095ac9ad6b2c` | `1891f310-c071-705a-2c72-0d0a33c92bf0` |
| Stefan Hamilton | `b8006f2b-0ec7-4107-b05a-b4c6b49541fd` | `08617390-b001-708d-f61e-07a1698282ec` |

## Development Best Practices

### TanStack Query Cache Pattern

**Problem:** Storing entity objects in local state creates stale snapshots that don't update when the cache refetches.

**Solution:** Store IDs in state, look up entities from cache.

```typescript
// ❌ BAD - Creates stale snapshot
const [editingAction, setEditingAction] = useState<Action | null>(null);
<Dialog action={editingAction} />

// ✅ GOOD - Always fresh from cache
const [editingActionId, setEditingActionId] = useState<string | null>(null);
const editingAction = actions.find(a => a.id === editingActionId);
<Dialog action={editingAction} />
```

**When to use:**
- Edit dialogs (Actions, Missions, Issues, Tools, etc.)
- Any component that displays cached data that can be updated elsewhere
- Forms that stay open during save operations

**Implementation:**
- Store only the ID in `useState`
- Look up the entity from the TanStack Query cache using `find()`
- The lookup always returns fresh data after refetches

See `src/pages/Actions.tsx` for reference implementation.

## What technologies are used for this project?

This project is built with:

- **Frontend**: React 18, TypeScript, Vite
- **UI Components**: shadcn-ui, Radix UI, Tailwind CSS
- **Database**: AWS RDS PostgreSQL
- **Authentication**: AWS Cognito
- **State Management**: React Query (TanStack Query)
- **Forms**: React Hook Form with Zod validation
- **Rich Text**: Tiptap editor
- **Image Processing**: Browser Image Compression
- **Date Handling**: date-fns
- **Icons**: Lucide React

## Testing

Run the test suite:
```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:ui             # UI mode
npm run test:coverage       # With coverage
```

### API Endpoint Tests

Test specific API endpoints:
```bash
# Get auth token from browser (copy from Network tab)
TOKEN="Bearer eyJraWQ..."

# Test action_implementation_updates endpoint
./tests/api/action-implementation-updates-502.test.sh "$TOKEN"
```

See `docs/502-ERROR-ACTION-IMPLEMENTATION-UPDATES.md` for troubleshooting 502 errors.

### Legacy Files (To Be Removed)
The following files are legacy from the Supabase era and should be ignored:
- `supabase/` directory
- Any files referencing `@supabase/supabase-js`
- `SUPABASE_TO_AWS_MIGRATION_PLAN.md` (migration is complete)

### Semantic Search

The application uses AWS Bedrock Titan embeddings for semantic search across tools and parts.

**Architecture:**
- `cwf-semantic-search` Lambda: Handles search requests, generates embeddings via Bedrock, queries vector database
- `cwf-embeddings-lambda`: Standalone Lambda for generating embeddings (used by backfill scripts)
- VPC Endpoint: `bedrock-runtime` endpoint allows Lambda in VPC to access Bedrock
- Database: PostgreSQL with pgvector extension for vector similarity search
- **Embedding Model**: Amazon Titan Text Embeddings v1 (1536 dimensions)
- **Indexed Fields**: Only `name` and `description` fields are embedded for semantic search

**Backfill embeddings:**
```bash
./backfill-embeddings-full-context.sh
```

This generates embeddings for all tools and parts using their name and description fields.

**Search endpoint:**
```bash
POST /api/semantic-search
{
  "query": "search text",
  "table": "parts" | "tools",
  "limit": 10
}
```

### TODO / Known Issues

- **Proper Solution**: Implement presigned URL generation via backend Lambda
  1. Create Lambda endpoint: `POST /api/upload/presigned-url`
  2. Lambda generates temporary presigned URL with expiration
  3. Frontend uploads directly to S3 using presigned URL
  4. Remove `VITE_AWS_ACCESS_KEY_ID` and `VITE_AWS_SECRET_ACCESS_KEY` from frontend
- **Files**: `src/hooks/useImageUpload.tsx`, `src/lib/s3Client.ts`

#### Database Functions & Triggers

  - **Important**: All Lambda functions MUST pass `organization_id` explicitly from the authorizer context. The stub function is ONLY for legacy triggers.
  - **Proper Fix Needed**: 
    1. Find all triggers using `get_user_organization_id()` (see `find-triggers-using-org-id.sql`)
    2. Remove triggers or update them to not use this function
    3. Verify all Lambda INSERT statements explicitly include `organization_id` from authorizer context (NOT from request body)
    4. Remove stub function once triggers are cleaned up
  - **Files**: `fix-get-user-org-id.sql`, `find-triggers-using-org-id.sql`
