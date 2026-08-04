# Engine Command Catalog

Status: Phase 1 (binary string-table extraction, 2026-07-31). See issue #148.

## What this is

A living catalog of the admin/console command surface of Funcom's closed-source
dedicated server (the `seabass-server` container image). Goal: know what the
engine natively supports instead of guessing. Direct motivation: find an
engine-native way to fill containers without a server restart
(INC-2026-07-31-001), and scope the fork's console admin features to what the
engine actually implements.

## Method and evidence (reproducible)

- Engine image: `registry.funcom.com/funcom/self-hosting/seabass-server:2051294-0-shipping`
  (Funcom's own published self-hosting image; the engine binary
  `DuneSandboxServer-Linux-Shipping`, 374 MB, is compiled into it).
- Extracted strings with `strings -t d -n 8` (GNU binutils) to
  /tmp/opencode/engine-strings-off.txt (966358 entries).
- Command names are literally compiled into the binary; e.g. verified at
  explicit byte offsets: `UpdateAllWaterFillables` @96410317, `AddItemToInventory`
  x9 occurrences, `AwardXP` x5, `TeleportTo` x36, `KickPlayer` x12.
- Sorted string tables (alphabetically contiguous runs) were identified
  programmatically; 117 runs found, of which 59 are Dune-specific command
  tables (the rest are UE engine/TIFF/ICU/PlayFab symbol tables).
- Command classes found in the binary's RTTI:
  - `UDuneServerCommandSubsystem` - the FLS (Funcom Live Services) ServerCommand
    channel handler (`DuneServerCommands/DuneServerCommandSubsystem.cpp`).
  - `UDuneServerCommandsCheatManager` - UE cheat/console exec surface
    (`DuneServerCommands/DuneServerCommandsCheatManager.cpp`).
  - Broadcast payload structs: FServerBroadcastPayload, FGenericBroadcastPayload,
    FLocalizedServerBroadcastPayload, FServerShutdownBroadcastPayload.
- FLS transport (observed live, read-only): Funcom's own RabbitMQ container
  (`seabass-server-rabbitmq`), exchange `heartbeats` (direct), routing key
  `notifications`, `app_id=fls_backend`, `user_id=fls`. The fork's scripts
  impersonate the FLS backend when publishing admin commands; the engine
  executes them and logs `Now running ServerCommand '<name>'` (Funcom's own
  logger in the server logs).

## Confidence levels

- **FLS-VERIFIED**: observed executing in the engine log on this server after
  being published over the FLS channel (and/or shipped in the fork's known-good
  `admin-tools.sh` set).
- **compiled-in**: string present in the engine binary as a command-name-shaped
  token in a sorted command table; NOT yet verified to execute over the FLS
  channel or console exec. The engine's cheat-manager surface may be gated
  (e.g. shipping builds may block some of these); verification is Phase 2.
- Internal/event-handler names (Get*/HandleOn*/On*/Client*/Multicast*/Server*)
  are almost certainly not directly invocable commands; they are listed for
  completeness but should be treated as noise unless a source path or adjacent
  table says otherwise.

## FLS-VERIFIED commands (this host, engine log)

- `CleanPlayerInventory`
- `ResetProgression`
- `SkillsSetModuleLevel`
- `SkillsSetUnspentSkillPoints`
- `SpawnVehicleAt`
- `TeleportTo`
- `UpdateAllWaterFillables`

These are the only commands confirmed to execute via the fork's FLS channel
mechanism (heartbeats/notifications). The fork's `admin-tools.sh` set also
includes `GrantTemplate` (custom multi-step grant, engine-verified via
AddItemToInventory flow) and `SpecializationXP`.

## Catalog by domain (855 compiled-in candidates; unverified unless marked)

### inventory_items (44)
- `AddAllVehicleModules`
- `AddBasicInventoryToCharacter`
- `AddItemToVehicleInventory`
- `AddItemsToInventory`
- `AddModuleToVehicle`
- `AddRequiredItemsToAllInventoryGeneratorsInClosestBase`
- `AddRequiredItemsToAllInventoryGeneratorsInServer`
- `AddWeaponBrokenTemporaryEffect`
- `AddWeaponToInventory`
- `AuditPlayerInventories`
- `DisplayInventoryCircuitsFromNearbyTotem`
- `FillEquippedCatchPockets`
- `ItemsPrintAllDeteriorationStats`
- `ItemsSetDurabilityAll`
- `ItemsSetDurabilityBackpack`
- `ItemsSetDurabilityEquipment`
- `ItemsSetDurabilityGadget`
- `ItemsSetDurabilityRadialShortcut`
- `MigrateMyVehicles`
- `PrintClosestPlaceableInfo`
- `PrintClosestPlaceableInventoryPointers`
- `PrintListMigratedVehicles`
- `PrintListMyVehicles`
- `PrintListRecoveredVehicles`
- `PrintListVehicles`
- `PrintListVehiclesMeshes`
- `PrintVehicleModules`
- `RemoveItemAmountFromBackpackByTemplateId`
- `RemoveModuleFromVehicle`
- `RepairAllItems`
- `RestoreRecoveredVehicle`
- `SetBackpackSize`
- `SetPlaceableWaterGenerationRate`
- `SetPlaceableWaterStored`
- `SetUpItemList`
- `SetVehicleCruiseModeEnabled`
- `SetVehicleCustomization`
- `SetVehicleFaction`
- `SetVehicleFuelPercentage`
- `SetVehicleModuleRelativeDurability`
- `SpawnVehicle`
- `SpawnVehicleAt` **FLS-VERIFIED**
- `UpdateAllFillables`
- `UpdateAllWaterFillables` **FLS-VERIFIED**

### teleport_travel (23)
- `GoToDimensionByTravel`
- `LocalTeleportTo`
- `ReturnToHomeDimension`
- `SummonPlayer`
- `TeleportActorTo`
- `TeleportFlyingCameraTo`
- `TeleportTo` **FLS-VERIFIED**
- `TeleportToExact`
- `TeleportToFindSpot`
- `TeleportToLocation`
- `TeleportToMap`
- `TeleportToNearestNpc`
- `TeleportToPlayer`
- `TeleportToSandworm`
- `TeleportToVehicleSpawner`
- `TheresNoPlaceLikeHome`
- `TravelTo`
- `TravelToByDestination`
- `TravelToDimension`
- `TravelToDimensionByDestination`
- `Unstuck`
- `UnstuckDebugStart`
- `UnstuckDebugStop`

### player_state (22)
- `DamageMe`
- `DealFatalDamage`
- `KillAllPlayers`
- `KillCharacter`
- `SetBodyType`
- `SetCharacterBlockMovement`
- `SetCharacterFloatStat`
- `SetCharacterRotationMode`
- `SetCharacterTemplate`
- `SetColdLevel`
- `SetColdProtectionValue`
- `SetDehydrationPenalty`
- `SetEyesOfIbad`
- `SetGodMode`
- `SetHasSpeedHax`
- `SetHydration`
- `SetPlayerHealth`
- `SetPlayerSkipSaving`
- `SetPlayerVisibility`
- `SetStaminaConsumption`
- `SetWalkKeyboardInputIntensity`
- `Suicide`

### loot (9)
- `LootDestroyAllTreasure`
- `LootPrintLootInfo`
- `LootPrintTreasureCount`
- `LootResetTemporaryLootContainerLifetimeAfterInteraction`
- `LootResetTemporaryLootContainersRespawnTime`
- `LootSetTemporaryLootContainerLifetimeAfterInteraction`
- `LootSetTemporaryLootContainersRespawnTime`
- `LootSpawnTreasure`
- `SetShipwrecksRevealStateInRange`

### npc_encounters (36)
- `ActivateNPCSpawning`
- `DestroyAllNpcs`
- `DestroySingleNpc`
- `EncountersActivateNearest`
- `EncountersDestroy`
- `EncountersDestroyNearest`
- `EncountersGetStatus`
- `EncountersList`
- `EncountersPrintNearestResetTimeLeft`
- `EncountersPrintStats`
- `EncountersResetNearest`
- `EncountersSetMaxInstancesNumber`
- `EncountersSetNearestResetTimeLeft`
- `EncountersSpawn`
- `FindNPCsByHash`
- `KillAllNpcs`
- `MoveToNPCWithEntityId`
- `NpcOverrideStat`
- `OverrideDungeonPlayerCount`
- `PatrolShipListSpawned`
- `PatrolShipPrintEnabled`
- `PatrolShipResetDetectionOnNearest`
- `PatrolShipSetEnabled`
- `PatrolShipSetMovementSpeedMultiplierOnNearest`
- `PatrolShipTeleportToNearest`
- `PatrolShipToggleSplineOfNearest`
- `PrintNarrowSightNPCs`
- `PrintNpcSpawnInfo`
- `PrintNumNpcs`
- `RespawnNPCs`
- `SetBossVulnerable`
- `ShowNPCDebugPanel`
- `ShowNpcControlPanel`
- `SpawnAi`
- `SpawnNPCWaveByName`
- `SpawnShipInFrontOfPlayer`

### coriolis (13)
- `CoriolisAutoSpawnCheckBoxChanged`
- `CoriolisDeath`
- `CoriolisPrintSeed`
- `CoriolisPrintStoredSeeds`
- `CoriolisRestartServer`
- `CoriolisSetFarmSeed`
- `CoriolisSetMapSeed`
- `CoriolisSetPartitionSeed`
- `SpawnCoriolis`
- `SpawnCoriolisEnd`
- `SpawnCoriolisSpinBoxCommitted`
- `SpawnCoriolisStage2`
- `SpawnCoriolisStage3`

### landsraad_faction (23)
- `DebugLandsraadActivateDecreeForFaction`
- `DebugLandsraadCastVote`
- `DebugLandsraadCompleteSysselraad`
- `DebugLandsraadDeactivateDecreeForFaction`
- `DebugLandsraadForceUpdateFromDatabase`
- `DebugLandsraadInsertRandomTaskProgress`
- `DebugLandsraadInsertTaskProgress`
- `DebugLandsraadInsertTaskProgressForFaction`
- `DebugLandsraadPrintGuildVote`
- `DebugLandsraadPrintHouseRewards`
- `DebugLandsraadRedeemHouseReward`
- `DebugLandsraadUpdateAllTasksRevealState`
- `DebugLandsraadUpdateTaskRevealState`
- `DebugLandsraadValidateBoard`
- `FactionAddReputationAmount`
- `FactionPrintAlignment`
- `FactionPrintLogs`
- `FactionPromoteToTier`
- `FactionResetFactionAlignment`
- `FactionSetPlayerAlignment`
- `FactionSetReputationAmount`
- `PayAllTaxesForNearbyTotem`
- `SpawnLandsraadControlPoint`

### sandworm_storm_spice (65)
- `DestroyAllSandStorms`
- `DestroyAllSandStormsOnThisMapAndDimension`
- `DestroySandStorm`
- `GiantWormEatMe`
- `GiantWormForceSpawnSequence`
- `GiantWormResetCooldown`
- `HaltAllSandStorms`
- `SandBuildupPrint`
- `SandBuildupSetEnabled`
- `SandBuildupSetOnAllObjects`
- `SandStormAutoSpawnNow`
- `SandStormAutoSpawnNowOnThisMapAndDimension`
- `SandStormSetOpacity`
- `SandwormActivateAttackAnimation`
- `SandwormActivateBreachAnimation`
- `SandwormActivateIdleAnimation`
- `SandwormActivateVerticalAttackAnimation`
- `SandwormCheckInsideSafezone`
- `SandwormClearTarget`
- `SandwormClearTargetAndThreatScore`
- `SandwormClientRegenerateSafezones`
- `SandwormDeactivateLoopingAnimation`
- `SandwormDeleteAllThreatBlobs`
- `SandwormEnableDebugWidget`
- `SandwormEnableDrawingThreatBlobs`
- `SandwormPrintLocations`
- `SandwormPrintSafeZoneStats`
- `SandwormPrintTerritories`
- `SandwormPrintThreatBlobs`
- `SandwormServerRegenerateSafezones`
- `SandwormSetCanBeTargeted`
- `SandwormSetIsDebugElevationActive`
- `SandwormSetMyThreatGeneration`
- `SandwormSetMyThreatScore`
- `SandwormSetSpawnProtection`
- `SandwormTargetMe`
- `SandwormTargetPlayer`
- `SetAuroraProbability`
- `SpawnSandStorm`
- `SpawnSandStormAngle`
- `SpawnSandStormPath`
- `SpiceAddictionConsumeSpice`
- `SpiceAddictionDecreaseSpiceAmount`
- `SpiceAddictionResetSpiceAddiction`
- `SpiceAddictionSetAddictionLevel`
- `SpiceAddictionSetConsumedSpice`
- `SpiceAddictionSetEnabledOnPlayer`
- `SpiceAddictionSetIsPlayerAddicted`
- `SpiceAddictionSetSpiceExposure`
- `SpiceAddictionSetSpiceTolerance`
- `SpiceFieldForceSpawnNearestField`
- `SpiceFieldPrimeNearestField`
- `SpiceFieldPrimeRandomField`
- `SpiceFieldPrintGlobalAvailability`
- `SpiceFieldPrintGlobalInformation`
- `SpiceFieldPrintNearestFieldInfo`
- `SpiceFieldReplenishNearestField`
- `SpiceFieldSetAgeForNearestField`
- `SpiceFieldSetFieldSpawnRate`
- `SpiceFieldSetSpawningEnabled`
- `SpiceFieldShowNearestFieldContents`
- `SpiceFieldTeleportToNearestField`
- `SpiceFieldUpdateGlobalRules`
- `SpiceVisionSetEnabledOnPlayer`
- `TriggerSpiceDream`

### print_info (67)
- `PrintAccessCodes`
- `PrintActiveGASEffects`
- `PrintAiBudgetingStats`
- `PrintAllCharacterFloatStats`
- `PrintAllGameplayAbilities`
- `PrintAllGameplayCues`
- `PrintAllNavGrids`
- `PrintAllOtherServersTravelDestinations`
- `PrintAllSpawnedProjectiles`
- `PrintAllTerrainBlocks`
- `PrintAllThisServerTravelDestinations`
- `PrintAllVehicleSpawner`
- `PrintBuildableListOnClient`
- `PrintBuildableListOnServer`
- `PrintCharacterData`
- `PrintCharacterFloatStat`
- `PrintCharacterGameplayTags`
- `PrintCharacterHomeworld`
- `PrintCharacterRotationInfo`
- `PrintCharacterState`
- `PrintCharacterSubstates`
- `PrintClientBuildingSystemStats`
- `PrintClosestTotemBuildables`
- `PrintClosestTotemInfo`
- `PrintCooldownStats`
- `PrintCurrentCameraValues`
- `PrintDamageImmunityState`
- `PrintDamageImmunityStateAllCharacters`
- `PrintDamageMitigationAttributes`
- `PrintEQSInfo`
- `PrintEnergyAttributes`
- `PrintEntityLods`
- `PrintEquippedAbilities`
- `PrintFOV`
- `PrintFarmDownTime`
- `PrintFarmStartTime`
- `PrintHUDUnlockLevel`
- `PrintHealthStats`
- `PrintHydrationStats`
- `PrintImmediatePhysicsStats`
- `PrintListPlayers`
- `PrintListPlayersInFarm`
- `PrintListVehicleProxies`
- `PrintLocalVehicleNetworkThresholds`
- `PrintLoreObjectsOnServer`
- `PrintMapSettings`
- `PrintMovementMode`
- `PrintNavGridInfo`
- `PrintNearestActiveVehicle`
- `PrintNearestVehicleLocation`
- `PrintNetStatus`
- `PrintNpcRespawnTimerHere`
- `PrintNumPlayers`
- `PrintNumPlayersInFarm`
- `PrintNumVehicles`
- `PrintOwnedIntelligencePoints`
- `PrintPlayerCap`
- `PrintPos`
- `PrintResourceLocationSystemInfo`
- `PrintSpecializationProgression`
- `PrintStaggerAttributes`
- `PrintSummarizedPos`
- `PrintSunExposureInfo`
- `PrintTimeOfDayInfo`
- `PrintUniverseTime`
- `PrintVehicleAbilities`
- `PrintXP`

### cheat_debug (26)
- `ApplyCheat`
- `CheatList`
- `CheckIgwArtificialBorder`
- `CraftingCostCheat`
- `CrashClient`
- `DemiGod`
- `EnableIGWDebug`
- `InfiniteDurability`
- `IsPlayerCheatEnabled`
- `NoFunAllowed`
- `ServerCheat`
- `SetBenchmarkName`
- `SetBypassBuildingPermissions`
- `SetDamageVisualizationEnabled`
- `SetIgnoreFactionRequirements`
- `SetNoBuildingCostsCheat`
- `TestIgwObjectFollowCurrentPlayer`
- `TestIgwObjectFollowRemotePlayer`
- `TestIgwObjectStopFollowingCurrentPlayer`
- `ToggleIGWDebug`
- `ToggleIncomingDamageNumbers`
- `ToggleSpeedHax`
- `TriggerHeapOutOfBoundsAccess`
- `TriggerHeapUseAfterFree`
- `WeaponInfiniteAmmo`
- `WeaponInfiniteAmmoReload`

## Phase 2 result (2026-08-04): FLS channel is a narrow allowlist

Live probes over the real FLS channel (exchange `heartbeats`, routing
`notifications`, `app_id=fls_backend`, builtin command-auth token) confirmed
the engine dispatches **only** the commands Funcom's cloud FLS backend actually
sends (the fork's ~12 FLS-VERIFIED commands). 25 probed candidates, including
all of the below, were rejected with
`Warning: Deserialized message has unknown Server Command '<name>'` (no-op,
no state change, no log spam beyond the single warning):

- Print/introspection (13): `PrintFarmStartTime`, `PrintListRecoveredVehicles`,
  `ListCommChannel`, `LootPrintLootInfo`, `CoriolisPrintSeed`,
  `FactionPrintAlignment`, `BotsPrintList`, `EncountersPrintStats`,
  `SandwormPrintLocations`, `PrintListPlayers`, `PrintPlayerCap`,
  `SessionMonitor_PlayersAsJson`, `ClaimSystemPrintCharacterPacks_Server`.
- Print/introspection (10): `PrintAccessCodes`, `PrintAllCharacterFloatStats`,
  `GlobalDistributionPrintLootSettingsForCurrentLocation`,
  `GlobalDistributionPrintTagsForCurrentLocation`, `CoriolisPrintStoredSeeds`,
  `ItemsPrintAllDeteriorationStats`, `DebugLandsraadPrintGuildVote`,
  `LootPrintTreasureCount`, `PatrolShipListSpawned`, `GetLastCoriolisTime`.
- State-changing fill candidates (3, operator-approved): `UpdateAllFillables`,
  `AddItemToVehicleInventory`, `SetPlaceableWaterStored`.

Positive control: `KickPlayer` with a nonexistent PlayerId dispatched normally
(`Now running ServerCommand 'KickPlayer' ...`), proving the probe format is
valid and the rejections are real dispatch gates, not a malformed payload.

**Conclusion: no engine-native FLS command exists for filling storage
containers.** Only `UpdateAllWaterFillables` (officially self-host-able) works
over FLS. The 855-command table is the `UDuneServerCommandsCheatManager`
console/debug surface (`CHEAT-EXEC`, ServerExecRPC-gated and shipping-gated);
it is not reachable from the FLS ServerCommand channel. The
console fill-item != storage restart limitation (INC-2026-07-31-001) stands as
designed; a native fill feature is not feasible short of running the game
server with a server-side hook that writes through a command the engine will
honour at runtime, which the FLS dispatch gate does not provide for these
names.

## Immediate candidates for the container-fill problem (Phase 2 targets)

Phase 2 verdict above; the previously-listed candidates are recorded for
archive completeness:

- `UpdateAllFillables` - **REJECTED over FLS** (2026-08-04).
- `AddItemToVehicleInventory` - **REJECTED over FLS** (2026-08-04).
- `AddItemsToInventory` / `AddBasicInventoryToCharacter` - inventory mutation
  variants; unprobed (cheat-exec class, same gate).
- `SetPlaceableWaterStored` / `SetPlaceableWaterGenerationRate` - **on page:
  `SetPlaceableWaterStored` REJECTED over FLS** (2026-08-04); the rest of this
  class is unprobed and presumed same gate.
- `RepairAllItems` / `ItemsSetDurability*` / `ItemsPrintAllDeteriorationStats` -
  durability maintenance surface; unprobed, presumed same gate.
- `PrintClosestPlaceableInventoryPointers` / `AuditPlayerInventories` /
  `PrintClosestPlaceableInfo` - read-only introspection; unprobed, presumed
  same gate.
- `SetBackpackSize`, `SetPlayerVisibility`, `SummonPlayer`, `TeleportToPlayer`,
  `SetGodMode` - console-feature candidates (destructive/cheat-adjacent:
  gate behind explicit operator approval); unprobed, presumed same gate.

## Dangerous / clearly-not-for-prod commands (never probe on a live server)

`ToggleSpeedHax`, `SetHasSpeedHax`, `TriggerHeapUseAfterFree`,
`TriggerHeapOutOfBoundsAccess`, `CrashClient`, `KillAllPlayers`, `Suicide`,
`DeleteCharacter*`, `ResetProgression` (already exposed deliberately),
`SetGodMode`, `SetPlayerHealth`, `NoFunAllowed`, `WeaponInfiniteAmmo*`,
`EnforceNakedStart`, `SleepServer`.

## Open questions / next phases

1. Phase 2 (2026-08-04, DONE): FLS-channel verification completed. Verdict:
   FLS is a narrow allowlist; the cheat-exec class (`CHEAT-EXEC`) is not
   reachable over FLS. Native container-fill via FLS is not feasible.
2. Phase 3: full FLS protocol map (exchanges/queues/message shapes) and
   parameter-name discovery for each verified command (params live in the
   engine code near each command name; e.g. `PlayerId=`, `WaterAmount=`).
3. Phase 4: decide console features from the verified surface only; file
   separate issues per feature. The container-fill feature remains
   restart-based (INC-2026-07-31-001), which is the correct documented
   behaviour, not a gap awaiting a native command.
4. Refresh method: re-run strings extraction after every engine image update
   and diff the catalog (engine may add/remove commands between builds).
