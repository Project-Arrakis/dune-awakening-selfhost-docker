# Feature: Pre-Augmented Gear Grant

Branch: `feature/pre-augmented-gear-grant`

## Design

This feature adds the ability to grant weapons and armor with augmentations pre-applied at grant time, and to apply augmentations to existing inventory items. Previously, augments were only grantable as standalone consumable items, requiring players to craft and slot them at an Augmentation Station in-game.

## Augmentations in Dune Awakening

Per game mechanics:
- Augmentations are crafted from blueprints/schematics found in Testing Stations
- They can only be slotted into Plastanium-tier (mk6) weapons and armor
- They are applied via an Augmentation Station (base building)
- Once attached, they cannot be removed and reduce max durability by 2% each
- The number of augmentation slots is unlocked through the Crafting Specialization tree

## Architecture

### Two Approaches

**Approach A: Grant gear with augments pre-installed**
- Extends `giveItemToPlayer()` and `giveItemToStorage()` to accept an `augments` array
- Augments are written into the `FCustomizationStats` field of the `dune.items.stats` JSONB column
- Example stats payload:
  ```json
  {
    "FCustomizationStats": [["T6_Augment_Melee1", "T6_Augment_Damage1"], {}],
    "FItemStackAndDurabilityStats": [[], {"CurrentDurability": 100, "MaxDurability": 100, "DecayedMaxDurability": 100, "DecayedDurability": 100}]
  }
  ```
- Durability values are now initialized to 100 by default on DB-granted player items
- All pre-augmented grants force the database path (cannot go through RabbitMQ live grant)

**Approach B: Apply augments to an existing inventory item**
- New `augmentInventoryItem()` function in `duneDb.js`
- Merges augment IDs into an existing item's `FCustomizationStats`, preserving existing durability and augment data
- Deduplicates augment IDs automatically
- New API route: `POST /api/players/:id/augment-item`

## Files Changed

### Core Library
- `console/api/src/duneDb.js`
  - Added `validateAugmentIds()`, `buildItemStats()` helpers
  - Added `augmentInventoryItem()` — applies augments to existing DB items
  - Extended `giveItemToPlayer()` — accepts `augments: []`, populates durability stats
  - Extended `giveItemToStorage()` — accepts `augments: []`

### Server Routes
- `console/api/src/server.js`
  - Added route: `POST /api/players/:id/augment-item` → `duneDb.augmentInventoryItem()`
  - Updated `giveSingleItemRoute()` — passes `augments` from body; forces DB path when augments present
  - Updated `grantPlayerItem()` — passes `augments` to `giveItemToPlayer()`

### Care Package
- `console/api/src/carePackage.js`
  - Updated `validateCarePackageItem()` — validates and passes through `augments` array
  - Updated `grantCarePackage()` — passes augments to DB grant path

## API Contract

### POST /api/players/:id/augment-item

```json
{
  "itemId": 501,
  "augments": ["T6_Augment_Melee1", "T6_Augment_Damage1"],
  "confirmation": "APPLY AUGMENTS"
}
```

Response:
```json
{
  "ok": true,
  "itemId": 501,
  "templateId": "UniqueSword",
  "augments": ["T6_Augment_Melee1", "T6_Augment_Damage1"],
  "previous": []
}
```

### POST /api/players/:id/give-item (with augments)

```json
{
  "itemName": "Replica Pulse-sword",
  "quantity": 1,
  "quality": 5,
  "augments": ["T6_Augment_Melee1", "T6_Augment_Melee4"]
}
```

### Care Package item (with augments)

```json
{
  "itemName": "Replica Pulse-sword",
  "quantity": 1,
  "quality": 5,
  "augments": ["T6_Augment_Melee1"]
}
```

## Security Considerations

- Augment IDs validated via `validateTemplateId()` — same regex constraints as all item template IDs: `/^[A-Za-z0-9_./:-]{1,240}$/`
- Augment arrays capped at 20 entries
- All augment-item operations require the "APPLY AUGMENTS" confirmation phrase
- Durability initialization for DB-granted items provides sensible defaults (100) — avoids undefined/null state
- No new environment variables, tokens, or secrets introduced
- All operations are audit-logged through existing audit infrastructure

## Testing

- `console/api/test/db.test.js`: 7 new tests covering:
  - Player give-item with augments populates FCustomizationStats
  - Player give-item with augments forces DB path on grade 0 items
  - Storage give-item with augments populates FCustomizationStats
  - Augment inventory item applies augment IDs to existing item
  - Augment inventory item merges with existing augments
  - Augment inventory item deduplicates augment IDs
  - Augment inventory item requires valid augment IDs

- All 266 existing tests continue to pass
- Secret keyword scan passes (no new secrets)
- Git whitespace/conflict check passes

## Limitations

- The CLI tools (`admin-tools.sh`) use RabbitMQ for live grants, which does not support `FCustomizationStats`. Pre-augmented gear grants must go through the web API or direct database operations.
- This feature populates the database representation of augment slots. The game client's behavior when receiving items with pre-populated `FCustomizationStats` has not been tested live — players may need to relog or refresh inventory for the augment state to sync.
