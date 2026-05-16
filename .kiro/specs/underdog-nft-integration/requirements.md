# Requirements Document

## Introduction

This feature integrates Clever Widget Factory (CWF) with the Underdog Protocol to mint compressed NFTs on Solana for workers when they complete actions. Workers receive NFTs as recognition artifacts — each NFT contains a link to an image and an associated poem. Workers use Managed Wallets (Passports) provisioned by Underdog so they never need a crypto app or self-managed wallet. CWF calls the Underdog API directly and does not grant Underdog access to the CWF database.

## Glossary

- **Underdog_API**: The Underdog Protocol REST API used to provision wallets and mint NFTs
- **Managed_Wallet**: A custodial Solana wallet provisioned and managed by Underdog on behalf of a worker (also called a Passport)
- **NFT**: A compressed non-fungible token on the Solana blockchain representing a worker's completed action
- **NFT_Artifact**: The combination of an image URL and an associated poem that forms the content of an NFT
- **Action**: A documented work activity in CWF with a status lifecycle (draft → completed, etc.)
- **Worker**: An organization member in CWF who performs and documents actions
- **Administrator**: An organization member with elevated permissions who manages workers and settings
- **CWF**: Clever Widget Factory — the asset management and accountability system

## Requirements

### Requirement 1: Worker NFT Identity via Underdog Passport (Lazy Provisioning)

**User Story:** As a worker, I want to receive NFTs without needing a crypto wallet or seed phrase, so that I can collect recognition artifacts from my completed actions without any web3 setup.

#### Acceptance Criteria

1. THE System SHALL identify each worker to the Underdog_API using the worker's unique CWF identifier (their Cognito user ID or email) as the Passport identifier
2. WHEN minting an NFT for a worker, THE System SHALL pass the worker's identifier in the `receiver` field of the Underdog_API mint request so that Underdog automatically routes the NFT to the worker's Passport
3. THE System SHALL use the `public` namespace for all Passport identifiers
4. THE System SHALL NOT require workers to create or manage a Solana wallet in order to receive NFTs
5. THE System SHALL NOT pre-provision Managed Wallets — wallet creation is handled implicitly by the Underdog_API on first mint

---

### Requirement 2: NFT Artifact Content (Image and Poem)

**User Story:** As a worker, I want my NFT to contain an image and an associated poem that I chose, so that the NFT is a meaningful and personal recognition artifact for my completed action.

#### Acceptance Criteria

1. THE NFT_Artifact SHALL consist of two components: an image URL and a poem (text)
2. WHEN minting an NFT, THE System SHALL include the image URL in the `image` field of the Underdog_API mint request
3. WHEN minting an NFT, THE System SHALL include the poem text in the `description` field of the Underdog_API mint request
4. THE System SHALL allow the person initiating the mint to supply both the image URL and the poem text before the NFT is minted
5. THE System SHALL associate the NFT_Artifact (image URL and poem) with the specific Action for which the NFT is being minted
6. IF the image URL is not a valid URL, THEN THE System SHALL display a validation error and prevent the mint from proceeding
7. IF the poem text is empty, THEN THE System SHALL display a validation error and prevent the mint from proceeding

---

<!-- DRAFT — more requirements to be added -->
