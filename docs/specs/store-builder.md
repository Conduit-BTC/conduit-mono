# Store Builder Specification

## Overview

Store Builder enables merchants to generate standalone, protocol-native storefronts that interoperate with Market and Portal. Stores are created via AI-driven generation from templates.

## Core Flows

### Store Creation
1. Merchant authenticates (NIP-07/46)
2. Select template
3. AI generates store from merchant data
4. Customize (branding, layout)
5. Publish/deploy

### Store Management
1. Edit store configuration
2. Preview changes
3. Manage custom domain (future)

## Pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | BuilderHomePage | Template gallery |
| `/templates` | TemplatesPage | Browse templates |
| `/templates/:id` | TemplatePreview | Template details |
| `/editor` | EditorPage | Store configuration |
| `/preview` | PreviewPage | Live preview |
| `/stores` | MyStoresPage | Merchant's stores |

## Template System

### Template Structure
```
template/
├── layout.tsx        # Page layout component
├── components/       # Template-specific components
├── theme.json        # Color/font overrides
└── config.json       # Template metadata
```

### AI Generation Process
1. Fetch merchant profile (Kind 0)
2. Fetch merchant products (Kind 30402)
3. Apply template layout
4. Generate store configuration
5. Deploy static assets

## Store Architecture

Generated stores are static React apps that:
- Connect to Nostr relays for live data
- Support buyer authentication (NIP-07/46)
- Enable direct checkout (NWC)
- Use NIP-17 for buyer-merchant DMs

## Protocol Events

### Read (Store Visitor)
- Kind 0: Merchant profile
- Kind 30402: Products

### Publish (Store Visitor)
- Kind 4/44: DMs to merchant
- Kind 9734: Zap requests

## State Management

### Stores
- `useAccountStore` - Merchant auth
- `useStoreStore` - Store configuration
- `useTemplateStore` - Template catalog

## Deployment

### Store Builder App

| Environment | URL |
|-------------|-----|
| Production | `build.conduit.market` |
| Preview | `<branch>.conduit-store-builder.pages.dev` |

Same deployment pattern as Market/Merchant - Cloudflare Pages with automatic preview deployments.

---

## Generated Store Hosting

All generated storefronts are hosted on Cloudflare Pages via the Conduit account. Merchants don't need their own Cloudflare account.

### Hosting Tiers

| Tier | Domain | Price | Features |
|------|--------|-------|----------|
| **Subdomain** | `{store-name}.conduit.market` | $12/mo | SSL, CDN, Blossom media |
| **Custom Domain** | Merchant's domain | $21/mo | All above + DNS management |
| **Self-Host** | Merchant hosts | Free | Export static bundle, no managed hosting |

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Store Deployment Pipeline                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Store Builder App                    Conduit Backend                   │
│  ┌─────────────────┐                 ┌─────────────────┐               │
│  │ Merchant edits  │                 │ Deployment      │               │
│  │ store config    │────────────────►│ Service         │               │
│  │                 │   POST /deploy  │                 │               │
│  └─────────────────┘                 └────────┬────────┘               │
│                                               │                         │
│                                               ▼                         │
│                                      ┌─────────────────┐               │
│                                      │ Build Worker    │               │
│                                      │                 │               │
│                                      │ 1. Fetch config │               │
│                                      │ 2. Generate app │               │
│                                      │ 3. Build static │               │
│                                      │ 4. Deploy to CF │               │
│                                      └────────┬────────┘               │
│                                               │                         │
│                                               ▼                         │
│                                      ┌─────────────────┐               │
│                                      │ Cloudflare      │               │
│                                      │ Pages API       │               │
│                                      │                 │               │
│                                      │ - Create project│               │
│                                      │ - Upload assets │               │
│                                      │ - Configure DNS │               │
│                                      └─────────────────┘               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Cloudflare Integration

### Project Naming Convention

```
conduit-store-{store-id}
```

Example: `conduit-store-abc123` → `abc123.conduit.market`

### Cloudflare Pages API Usage

**Create Store Project:**
```typescript
// POST https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects
{
  "name": "conduit-store-abc123",
  "production_branch": "main"
}
```

**Deploy Store:**
```typescript
// POST https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/deployments
// Content-Type: multipart/form-data
// Upload the built static assets as a zip or directory
```

**Set Environment Variables:**
```typescript
// PATCH https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}
{
  "deployment_configs": {
    "production": {
      "env_vars": {
        "VITE_MERCHANT_PUBKEY": { "value": "npub1..." },
        "VITE_RELAY_URL": { "value": "wss://relay.conduit.market" },
        "VITE_STORE_ID": { "value": "abc123" }
      }
    }
  }
}
```

### Subdomain Configuration

For `{store-name}.conduit.market`:

1. **DNS Record** (Cloudflare DNS for conduit.market zone):
   ```
   Type: CNAME
   Name: {store-name}
   Target: conduit-store-{store-id}.pages.dev
   Proxied: Yes
   ```

2. **Custom Domain on Pages Project:**
   ```typescript
   // POST https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/domains
   {
     "name": "{store-name}.conduit.market"
   }
   ```

### Custom Domain Setup

For merchant-owned domains (Premium tier):

1. **Merchant provides domain** in Store Builder UI

2. **Conduit adds custom domain to Pages project:**
   ```typescript
   // POST .../pages/projects/{project_name}/domains
   {
     "name": "shop.merchantdomain.com"
   }
   ```

3. **Cloudflare returns required DNS records:**
   ```json
   {
     "result": {
       "name": "shop.merchantdomain.com",
       "status": "pending",
       "verification_data": {
         "txt_name": "_cf-custom-hostname",
         "txt_value": "abc123..."
       }
     }
   }
   ```

4. **Display DNS instructions to merchant:**
   ```
   Add these records to your domain's DNS:

   Type: CNAME
   Name: shop (or @ for root)
   Target: conduit-store-abc123.pages.dev

   Type: TXT (for verification)
   Name: _cf-custom-hostname.shop
   Value: abc123...
   ```

5. **Poll for verification:**
   ```typescript
   // GET .../pages/projects/{project_name}/domains/{domain_name}
   // Check status: "pending" → "active"
   ```

6. **SSL provisioned automatically** by Cloudflare once DNS propagates

---

## Store Deployment Service

### Backend Service (Cloudflare Worker or Edge Function)

```typescript
// infrastructure/store-deploy/src/index.ts

interface StoreDeployRequest {
  storeId: string
  merchantPubkey: string
  storeName: string  // Subdomain: "my-store" → my-store.conduit.market
  template: string
  config: StoreConfig
  customDomain?: string  // Optional: "shop.example.com"
}

interface StoreConfig {
  branding: {
    primaryColor: string
    logo?: string
    banner?: string
  }
  layout: {
    template: string
    heroEnabled: boolean
    gridColumns: number
  }
  relays: string[]
}

// Deployment endpoint
export async function handleDeploy(request: StoreDeployRequest) {
  const { storeId, merchantPubkey, storeName, template, config } = request

  // 1. Generate store bundle
  const bundle = await generateStoreBundle({
    template,
    config,
    envVars: {
      VITE_MERCHANT_PUBKEY: merchantPubkey,
      VITE_STORE_ID: storeId,
      VITE_RELAY_URL: config.relays[0] || "wss://relay.conduit.market",
    }
  })

  // 2. Create/update Cloudflare Pages project
  const projectName = `conduit-store-${storeId}`
  await createOrUpdateProject(projectName)

  // 3. Deploy bundle
  const deployment = await deployToPages(projectName, bundle)

  // 4. Configure subdomain
  await configureSubdomain(storeName, projectName)

  // 5. Configure custom domain if provided
  if (request.customDomain) {
    await configureCustomDomain(request.customDomain, projectName)
  }

  return {
    storeId,
    url: `https://${storeName}.conduit.market`,
    customDomainStatus: request.customDomain ? "pending_verification" : null,
    deploymentId: deployment.id,
  }
}
```

### Store Generation

```typescript
// Generate static React app from template + config
async function generateStoreBundle(options: GenerateOptions): Promise<Buffer> {
  const { template, config, envVars } = options

  // 1. Copy template to temp directory
  const tempDir = await copyTemplate(template)

  // 2. Apply config (theme, layout, branding)
  await applyConfig(tempDir, config)

  // 3. Write environment variables
  await writeEnvFile(tempDir, envVars)

  // 4. Build static assets
  await exec(`cd ${tempDir} && bun install && bun run build`)

  // 5. Zip dist folder
  return await zipDirectory(`${tempDir}/dist`)
}
```

---

## Store Lifecycle

### Create Store

1. Merchant selects template in Store Builder
2. Merchant customizes branding/layout
3. Merchant chooses store name (subdomain)
4. Deploy button triggers deployment service
5. Store goes live at `{store-name}.conduit.market`

### Update Store

1. Merchant edits config in Store Builder
2. "Republish" triggers new deployment
3. Cloudflare Pages automatically routes to latest deployment
4. Previous deployments kept for rollback

### Pause Store

```typescript
// Set store to maintenance mode
// Option 1: Deploy placeholder page
// Option 2: Use Cloudflare Access rules to block traffic
```

### Delete Store

1. Merchant requests deletion in Store Builder
2. Grace period (7 days) before permanent deletion
3. Delete Cloudflare Pages project:
   ```typescript
   // DELETE .../pages/projects/{project_name}
   ```
4. Remove DNS records
5. Purge from Conduit database

---

## Store Data Model

```typescript
interface Store {
  id: string                    // Unique store ID
  merchantPubkey: string        // Owner's Nostr pubkey
  name: string                  // Subdomain name
  template: string              // Template ID
  config: StoreConfig           // Branding, layout, etc.

  // Hosting
  cloudflareProjectId: string
  subdomain: string             // {name}.conduit.market
  customDomain?: string         // merchant's domain
  customDomainStatus?: "pending" | "active" | "failed"

  // Billing
  tier: "subdomain" | "custom_domain" | "self_host"
  billingStartDate?: Date

  // Status
  status: "draft" | "deploying" | "live" | "paused" | "deleted"
  lastDeployedAt?: Date
  deploymentUrl?: string

  createdAt: Date
  updatedAt: Date
}
```

---

## Environment Variables (Generated Stores)

```bash
# Injected at build time
VITE_MERCHANT_PUBKEY=npub1...           # Store owner
VITE_STORE_ID=abc123                    # Store identifier
VITE_RELAY_URL=wss://relay.conduit.market
VITE_DEFAULT_RELAYS=wss://relay.conduit.market,wss://relay.damus.io

# Optional
VITE_BLOSSOM_SERVER=https://blossom.conduit.market
VITE_PLAUSIBLE_DOMAIN={store-name}.conduit.market  # If analytics enabled
```

---

## Self-Host Export

For merchants who want to host their own store:

1. **Export Bundle** button in Store Builder
2. Download zip containing:
   - Built static assets (`dist/`)
   - `README.md` with hosting instructions
   - Sample nginx/Caddy config
   - Environment variable template

```markdown
# Hosting Your Conduit Store

## Static Files
Upload the contents of `dist/` to any static hosting provider:
- Cloudflare Pages
- Vercel
- Netlify
- AWS S3 + CloudFront
- Any web server (nginx, Apache, Caddy)

## Environment Variables
Set these in your hosting provider:
- VITE_MERCHANT_PUBKEY=your-npub
- VITE_RELAY_URL=wss://your-relay.com

## Updates
Re-export from Store Builder when you want to update your store.
```

---

## Security Considerations

### API Authentication

Store deployment API requires:
- Valid merchant signature (NIP-07/46)
- Merchant owns the store being modified
- Rate limiting per pubkey

### Store Name Validation

- Alphanumeric + hyphens only
- 3-63 characters
- No reserved words (`www`, `api`, `admin`, `shop`, `sell`, etc.)
- No existing store names
- No trademark violations (manual review for flagged names)

### Custom Domain Verification

- TXT record verification prevents domain hijacking
- Merchant must prove domain ownership
- Re-verification if domain lapses

---

## Privacy Constraints

- NO visitor tracking in generated stores
- NO analytics without explicit opt-in
- Merchant data pulled from relays only