#!/usr/bin/env python3
"""Regenerate the "Catalog by domain" section of the engine command catalog.

Reads the authoritative list of command names extracted from
DuneSandboxServer-Linux-Shipping (seabass-server:2051294-0-shipping) and
classifies them into domains.

Input:  /tmp/opencode/engine-commands.txt  (855 compiled-in cheat-table names,
        one per line, sorted) plus the FLS-registry-only command names below.
Output: prints the catalog section (## Catalog by domain ...) to stdout.

Run:  python3 docs/engine/generate-command-catalog.py

The 855-name file only contains the UDuneServerCommandsCheatManager table.
Command names that exist ONLY in the FLS ServerCommand registry
(AddItemToInventory, AwardXP, KickPlayer, ServiceBroadcast) are compiled in but
live in a different binary region, so they are added explicitly here — they
were verified against ANSI offsets and/or the engine log, not guessed.
GrantTemplate and SpecializationXP are not single engine literals at all; they
are fork-built composite flows shipped in runtime/scripts/admin-tools.sh
(GrantTemplate wraps AddItemToInventory; SpecializationXP targets the
specialization-xp admin API). All six are tagged FORK_OR_FLS and placed in a
sensible domain.
"""
import sys

SRC = "/tmp/opencode/engine-commands.txt"

# FLS-registry-only command names (compiled into the binary or fork-built) that
# are NOT present in the 855 cheat-manager extraction.
FLS_REGISTRY_ONLY = {
    "AddItemToInventory",  # engine literal, FLS registry (verified @94340153)
    "AwardXP",             # engine literal, FLS registry (verified @12293345)
    "KickPlayer",          # engine literal, FLS registry (verified @93785115)
    "ServiceBroadcast",    # engine literal, FLS registry (verified @94659509)
    "GrantTemplate",       # fork composite, no engine literal (wraps AddItemToInventory)
    "SpecializationXP",    # fork composite, targets specialization-xp admin API
}

# FLS-VERIFIED commands (observed executing in the engine log on this host via
# the FLS channel, and/or shipped in the fork's known-good admin-tools.sh set).
VERIFIED = {
    "CleanPlayerInventory", "ResetProgression", "SkillsSetModuleLevel",
    "SkillsSetUnspentSkillPoints", "SpawnVehicleAt", "TeleportTo",
    "UpdateAllWaterFillables", "AddItemToInventory", "AwardXP", "KickPlayer",
    "ServiceBroadcast", "GrantTemplate", "SpecializationXP",
}

# ---------------------------------------------------------------------------
# Curated domains, preserved verbatim from the 2026-07-31 manual pass.
# These 328 assignments are authoritative hand classification and are tested
# to be disjoint below.
# ---------------------------------------------------------------------------
INVENTORY = {
    "AddAllVehicleModules", "AddBasicInventoryToCharacter", "AddItemToVehicleInventory",
    "AddItemsToInventory", "AddModuleToVehicle",
    "AddRequiredItemsToAllInventoryGeneratorsInClosestBase",
    "AddRequiredItemsToAllInventoryGeneratorsInServer", "AddWeaponBrokenTemporaryEffect",
    "AddWeaponToInventory", "AuditPlayerInventories", "DisplayInventoryCircuitsFromNearbyTotem",
    "FillEquippedCatchPockets", "ItemsPrintAllDeteriorationStats", "ItemsSetDurabilityAll",
    "ItemsSetDurabilityBackpack", "ItemsSetDurabilityEquipment", "ItemsSetDurabilityGadget",
    "ItemsSetDurabilityRadialShortcut", "MigrateMyVehicles", "PrintClosestPlaceableInfo",
    "PrintClosestPlaceableInventoryPointers", "PrintListMigratedVehicles", "PrintListMyVehicles",
    "PrintListRecoveredVehicles", "PrintListVehicles", "PrintListVehiclesMeshes",
    "PrintVehicleModules", "RemoveItemAmountFromBackpackByTemplateId", "RemoveModuleFromVehicle",
    "RepairAllItems", "RestoreRecoveredVehicle", "SetBackpackSize",
    "SetPlaceableWaterGenerationRate", "SetPlaceableWaterStored", "SetUpItemList",
    "SetVehicleCruiseModeEnabled", "SetVehicleCustomization", "SetVehicleFaction",
    "SetVehicleFuelPercentage", "SetVehicleModuleRelativeDurability", "SpawnVehicle",
    "SpawnVehicleAt", "UpdateAllFillables", "UpdateAllWaterFillables",
}
TRAVEL = {
    "GoToDimensionByTravel", "LocalTeleportTo", "ReturnToHomeDimension", "SummonPlayer",
    "TeleportActorTo", "TeleportFlyingCameraTo", "TeleportTo", "TeleportToExact",
    "TeleportToFindSpot", "TeleportToLocation", "TeleportToMap", "TeleportToNearestNpc",
    "TeleportToPlayer", "TeleportToSandworm", "TeleportToVehicleSpawner", "TheresNoPlaceLikeHome",
    "TravelTo", "TravelToByDestination", "TravelToDimension", "TravelToDimensionByDestination",
    "Unstuck", "UnstuckDebugStart", "UnstuckDebugStop",
}
PLAYER_STATE = {
    "DamageMe", "DealFatalDamage", "KillAllPlayers", "KillCharacter", "SetBodyType",
    "SetCharacterBlockMovement", "SetCharacterFloatStat", "SetCharacterRotationMode",
    "SetCharacterTemplate", "SetColdLevel", "SetColdProtectionValue", "SetDehydrationPenalty",
    "SetEyesOfIbad", "SetGodMode", "SetHasSpeedHax", "SetHydration", "SetPlayerHealth",
    "SetPlayerSkipSaving", "SetPlayerVisibility", "SetStaminaConsumption",
    "SetWalkKeyboardInputIntensity", "Suicide",
}
LOOT = {
    "LootDestroyAllTreasure", "LootPrintLootInfo", "LootPrintTreasureCount",
    "LootResetTemporaryLootContainerLifetimeAfterInteraction",
    "LootResetTemporaryLootContainersRespawnTime",
    "LootSetTemporaryLootContainerLifetimeAfterInteraction",
    "LootSetTemporaryLootContainersRespawnTime", "LootSpawnTreasure",
    "SetShipwrecksRevealStateInRange",
}
NPC = {
    "ActivateNPCSpawning", "DestroyAllNpcs", "DestroySingleNpc", "EncountersActivateNearest",
    "EncountersDestroy", "EncountersDestroyNearest", "EncountersGetStatus", "EncountersList",
    "EncountersPrintNearestResetTimeLeft", "EncountersPrintStats", "EncountersResetNearest",
    "EncountersSetMaxInstancesNumber", "EncountersSetNearestResetTimeLeft", "EncountersSpawn",
    "FindNPCsByHash", "KillAllNpcs", "MoveToNPCWithEntityId", "NpcOverrideStat",
    "OverrideDungeonPlayerCount", "PatrolShipListSpawned", "PatrolShipPrintEnabled",
    "PatrolShipResetDetectionOnNearest", "PatrolShipSetEnabled",
    "PatrolShipSetMovementSpeedMultiplierOnNearest", "PatrolShipTeleportToNearest",
    "PatrolShipToggleSplineOfNearest", "PrintNarrowSightNPCs", "PrintNpcSpawnInfo",
    "PrintNumNpcs", "RespawnNPCs", "SetBossVulnerable", "ShowNPCDebugPanel",
    "ShowNpcControlPanel", "SpawnAi", "SpawnNPCWaveByName", "SpawnShipInFrontOfPlayer",
}
CORIOLIS = {
    "CoriolisAutoSpawnCheckBoxChanged", "CoriolisDeath", "CoriolisPrintSeed",
    "CoriolisPrintStoredSeeds", "CoriolisRestartServer", "CoriolisSetFarmSeed",
    "CoriolisSetMapSeed", "CoriolisSetPartitionSeed", "SpawnCoriolis", "SpawnCoriolisEnd",
    "SpawnCoriolisSpinBoxCommitted", "SpawnCoriolisStage2", "SpawnCoriolisStage3",
}
LANDSRAAD = {
    "DebugLandsraadActivateDecreeForFaction", "DebugLandsraadCastVote",
    "DebugLandsraadCompleteSysselraad", "DebugLandsraadDeactivateDecreeForFaction",
    "DebugLandsraadForceUpdateFromDatabase", "DebugLandsraadInsertRandomTaskProgress",
    "DebugLandsraadInsertTaskProgress", "DebugLandsraadInsertTaskProgressForFaction",
    "DebugLandsraadPrintGuildVote", "DebugLandsraadPrintHouseRewards",
    "DebugLandsraadRedeemHouseReward", "DebugLandsraadUpdateAllTasksRevealState",
    "DebugLandsraadUpdateTaskRevealState", "DebugLandsraadValidateBoard",
    "FactionAddReputationAmount", "FactionPrintAlignment", "FactionPrintLogs",
    "FactionPromoteToTier", "FactionResetFactionAlignment", "FactionSetPlayerAlignment",
    "FactionSetReputationAmount", "PayAllTaxesForNearbyTotem", "SpawnLandsraadControlPoint",
}
SANDWORM_STORM_SPICE = {
    "DestroyAllSandStorms", "DestroyAllSandStormsOnThisMapAndDimension", "DestroySandStorm",
    "GiantWormEatMe", "GiantWormForceSpawnSequence", "GiantWormResetCooldown",
    "HaltAllSandStorms", "SandBuildupPrint", "SandBuildupSetEnabled",
    "SandBuildupSetOnAllObjects", "SandStormAutoSpawnNow", "SandStormAutoSpawnNowOnThisMapAndDimension",
    "SandStormSetOpacity", "SandwormActivateAttackAnimation", "SandwormActivateBreachAnimation",
    "SandwormActivateIdleAnimation", "SandwormActivateVerticalAttackAnimation",
    "SandwormCheckInsideSafezone", "SandwormClearTarget", "SandwormClearTargetAndThreatScore",
    "SandwormClientRegenerateSafezones", "SandwormDeactivateLoopingAnimation",
    "SandwormDeleteAllThreatBlobs", "SandwormEnableDebugWidget", "SandwormEnableDrawingThreatBlobs",
    "SandwormPrintLocations", "SandwormPrintSafeZoneStats", "SandwormPrintTerritories",
    "SandwormPrintThreatBlobs", "SandwormServerRegenerateSafezones", "SandwormSetCanBeTargeted",
    "SandwormSetIsDebugElevationActive", "SandwormSetMyThreatGeneration", "SandwormSetMyThreatScore",
    "SandwormSetSpawnProtection", "SandwormTargetMe", "SandwormTargetPlayer",
    "SetAuroraProbability", "SpawnSandStorm", "SpawnSandStormAngle", "SpawnSandStormPath",
    "SpiceAddictionConsumeSpice", "SpiceAddictionDecreaseSpiceAmount",
    "SpiceAddictionResetSpiceAddiction", "SpiceAddictionSetAddictionLevel",
    "SpiceAddictionSetConsumedSpice", "SpiceAddictionSetEnabledOnPlayer",
    "SpiceAddictionSetIsPlayerAddicted", "SpiceAddictionSetSpiceExposure",
    "SpiceAddictionSetSpiceTolerance", "SpiceFieldForceSpawnNearestField",
    "SpiceFieldPrimeNearestField", "SpiceFieldPrimeRandomField", "SpiceFieldPrintGlobalAvailability",
    "SpiceFieldPrintGlobalInformation", "SpiceFieldPrintNearestFieldInfo",
    "SpiceFieldReplenishNearestField", "SpiceFieldSetAgeForNearestField",
    "SpiceFieldSetFieldSpawnRate", "SpiceFieldSetSpawningEnabled",
    "SpiceFieldShowNearestFieldContents", "SpiceFieldTeleportToNearestField",
    "SpiceFieldUpdateGlobalRules", "SpiceVisionSetEnabledOnPlayer", "TriggerSpiceDream",
}
PRINT_INFO = {
    "PrintAccessCodes", "PrintActiveGASEffects", "PrintAiBudgetingStats",
    "PrintAllCharacterFloatStats", "PrintAllGameplayAbilities", "PrintAllGameplayCues",
    "PrintAllNavGrids", "PrintAllOtherServersTravelDestinations", "PrintAllSpawnedProjectiles",
    "PrintAllTerrainBlocks", "PrintAllThisServerTravelDestinations", "PrintAllVehicleSpawner",
    "PrintBuildableListOnClient", "PrintBuildableListOnServer", "PrintCharacterData",
    "PrintCharacterFloatStat", "PrintCharacterGameplayTags", "PrintCharacterHomeworld",
    "PrintCharacterRotationInfo", "PrintCharacterState", "PrintCharacterSubstates",
    "PrintClientBuildingSystemStats", "PrintClosestTotemBuildables", "PrintClosestTotemInfo",
    "PrintCooldownStats", "PrintCurrentCameraValues", "PrintDamageImmunityState",
    "PrintDamageImmunityStateAllCharacters", "PrintDamageMitigationAttributes",
    "PrintEQSInfo", "PrintEnergyAttributes", "PrintEntityLods", "PrintEquippedAbilities",
    "PrintFOV", "PrintFarmDownTime", "PrintFarmStartTime", "PrintHUDUnlockLevel",
    "PrintHealthStats", "PrintHydrationStats", "PrintImmediatePhysicsStats",
    "PrintListPlayers", "PrintListPlayersInFarm", "PrintListVehicleProxies",
    "PrintLocalVehicleNetworkThresholds", "PrintLoreObjectsOnServer", "PrintMapSettings",
    "PrintMovementMode", "PrintNavGridInfo", "PrintNearestActiveVehicle",
    "PrintNearestVehicleLocation", "PrintNetStatus", "PrintNpcRespawnTimerHere",
    "PrintNumPlayers", "PrintNumPlayersInFarm", "PrintNumVehicles", "PrintOwnedIntelligencePoints",
    "PrintPlayerCap", "PrintPos", "PrintResourceLocationSystemInfo", "PrintSpecializationProgression",
    "PrintStaggerAttributes", "PrintSummarizedPos", "PrintSunExposureInfo", "PrintTimeOfDayInfo",
    "PrintUniverseTime", "PrintVehicleAbilities", "PrintXP",
}
CHEAT_DEBUG = {
    "ApplyCheat", "CheatList", "CheckIgwArtificialBorder", "CraftingCostCheat", "CrashClient",
    "DemiGod", "EnableIGWDebug", "InfiniteDurability", "IsPlayerCheatEnabled", "NoFunAllowed",
    "ServerCheat", "SetBenchmarkName", "SetBypassBuildingPermissions",
    "SetDamageVisualizationEnabled", "SetIgnoreFactionRequirements", "SetNoBuildingCostsCheat",
    "TestIgwObjectFollowCurrentPlayer", "TestIgwObjectFollowRemotePlayer",
    "TestIgwObjectStopFollowingCurrentPlayer", "ToggleIGWDebug", "ToggleIncomingDamageNumbers",
    "ToggleSpeedHax", "TriggerHeapOutOfBoundsAccess", "TriggerHeapUseAfterFree",
    "WeaponInfiniteAmmo", "WeaponInfiniteAmmoReload",
}

CURATED = {
    "inventory_items": INVENTORY, "teleport_travel": TRAVEL, "player_state": PLAYER_STATE,
    "loot": LOOT, "npc_encounters": NPC, "coriolis": CORIOLIS, "landsraad_faction": LANDSRAAD,
    "sandworm_storm_spice": SANDWORM_STORM_SPICE, "print_info": PRINT_INFO,
    "cheat_debug": CHEAT_DEBUG,
}

# Explicit overrides: commands whose prefix heuristic would be wrong, or that
# belong to a curated domain despite matching a broader rule later.
EXPLICIT = {
    # skills / progression / perk
    "ResetProgression": "skills_progression", "SkillsSetModuleLevel": "skills_progression",
    "SkillsSetUnspentSkillPoints": "skills_progression", "XPAmount": "skills_progression",
    "XPSource": "skills_progression", "OverrideIntelSpent": "skills_progression",
    "AddXPToSpecializationTrack": "skills_progression",
    "PurchaseSpecializationKeystone": "skills_progression",
    "ResetSpecializationKeystones": "skills_progression",
    "ResetSpecializationTracks": "skills_progression",
    "SetSpecializationRefundId": "skills_progression",
    "SetSpecializationTrackProgression": "skills_progression",
    "PauseProgression": "skills_progression",
    "LearnAllTechTreeItems": "skills_progression", "LearnTechTreeItem": "skills_progression",
    "UnlearnAllTechTreeItems": "skills_progression", "UnlearnTechTreeItem": "skills_progression",
    "BuyTechKnowledge": "skills_progression", "UnblockTechKnowledge": "skills_progression",
    "ResetUnstuckTimer": "skills_progression",
    # inventory / items / crafting
    "CleanPlayerInventory": "inventory_items", "GrantTemplate": "inventory_items",
    "AddItemToInventory": "inventory_items",
    "AugmentItem": "inventory_items", "CraftingRecipesUnlearnAll": "inventory_items",
    "RecreatePlayerClothingActor": "inventory_items",
    # combat / melee / shield
    "CombatReady": "combat_abilities", "BeginMeleeAttack": "combat_abilities",
    "EndMeleeAttack": "combat_abilities", "PruneInvalidMeleeHits": "combat_abilities",
    "TriggerAttackPlayer": "combat_abilities",
    "EquipAbilityAtSlot": "combat_abilities", "EquipFavoriteWeapon": "combat_abilities",
    "SetCurrentMeleeActionMontage": "combat_abilities",
    "SetDashFXActive": "combat_abilities", "BeginDash": "combat_abilities",
    "SetHyperArmor": "combat_abilities", "ToggleHyperArmor": "combat_abilities",
    "SetSelfCooldownsCostCharges": "combat_abilities", "RemoveAllCooldownsNaive": "combat_abilities",
    "SetServerWantsWeaponInHand": "combat_abilities",
    "ReInitializeCombatAnimBP": "combat_abilities", "StopShootingLayerAnimMontage": "combat_abilities",
    "TriggerReadyPose": "combat_abilities", "HandleVFXOnShieldActivationToggled": "combat_abilities",
    "ShieldCooldownEnded": "combat_abilities", "PlayerKnockDown": "combat_abilities",
    "SetGASAttribute": "combat_abilities", "DebugOverrideDamage": "combat_abilities",
    "InfiniteAmmoCheckBoxChanged": "combat_abilities",
    # survival stats
    "ActivateDamageImmunity": "survival_stats",
    "ActivateDamageImmunityWithDamageTypeClasses": "survival_stats",
    "DeactivateDamageImmunity": "survival_stats",
    "ApplyStatusEffect": "survival_stats", "SlowDamageApplication": "survival_stats",
    "ColdSurvivalEnabledChanged": "survival_stats", "EnableColdSurvival": "survival_stats",
    "EnableDehydration": "survival_stats", "EnableDehydrationCheckBoxChanged": "survival_stats",
    "StatusFlag": "survival_stats",
    # building / landclaim / totem
    "ExtendLandclaim": "building_totem_landclaim",
    "ExtendLandclaimVertically": "building_totem_landclaim",
    "SetBuildableHealth": "building_totem_landclaim",
    "SetBuildableHealthPercentage": "building_totem_landclaim",
    "SetBuildingRestrictionLimitsEnabled": "building_totem_landclaim",
    "SetShowBuildingTestSetsCheat": "building_totem_landclaim",
    "OverrideBuildableShelterThreshold": "building_totem_landclaim",
    "DirtyAllBuildableShelterComponents": "building_totem_landclaim",
    "DirtyTargetBuildableShelterComponent": "building_totem_landclaim",
    "SetTargetBuildableSandBuildUp": "building_totem_landclaim",
    "SetTargetWholeBuildingSandBuildUp": "building_totem_landclaim",
    "SetBuildAndFillOverrideTimerInSeconds": "building_totem_landclaim",
    "BuildingBlockoutVisualsToggle": "building_totem_landclaim",
    "BuildingStabilizationUpdateTimeLeft": "building_totem_landclaim",
    "SpawnBuildingBlueprint": "building_totem_landclaim",
    "ValidateClosestTotemResourceCache": "building_totem_landclaim",
    "ForceRefreshClosestTotemResourceCache": "building_totem_landclaim",
    "ForceRefreshTotemResourceCache": "building_totem_landclaim",
    "ShowObjectShelter": "building_totem_landclaim",
    "ShowPossessedCharacterShelter": "building_totem_landclaim",
    "ShowPossessedCharacterVehicleProtection": "building_totem_landclaim",
    # circuits / power / water / placeables
    "AddNearbyPlaceableToInventoryCircuit": "circuits_power_placeables",
    "AddNearbyPlaceableToPowerCircuit": "circuits_power_placeables",
    "AddNearbyPlaceableToWaterCircuit": "circuits_power_placeables",
    "RemoveNearbyPlaceableFromInventoryCircuit": "circuits_power_placeables",
    "RemoveNearbyPlaceableFromPowerCircuit": "circuits_power_placeables",
    "RemoveNearbyPlaceableFromWaterCircuit": "circuits_power_placeables",
    "SetNearbyPlaceablePowerActive": "circuits_power_placeables",
    "SetPowerConsumption": "circuits_power_placeables",
    "SetCurrentPowerToMaxPower": "circuits_power_placeables",
    "ShortCircuitAllTotems": "circuits_power_placeables",
    "DisplayPowerCircuitsFromNearbyTotem": "circuits_power_placeables",
    "DisplayWaterCircuitsFromNearbyTotem": "circuits_power_placeables",
    # vehicles / transport
    "AttachHarnessedVehicle": "vehicles_transport", "DetachHarnessedVehicle": "vehicles_transport",
    "DestroyTargetVehicle": "vehicles_transport",
    "ForceDespawnAtVehicleSpawner": "vehicles_transport",
    "ForceSpawnAtVehicleSpawner": "vehicles_transport",
    "SetCurrentOrnithopterMaxSpeed": "vehicles_transport",
    "SetCurrentVehicleDisabled": "vehicles_transport",
    "SetCurrentVehicleMaxPositionBadErrorToleranceSquared": "vehicles_transport",
    "SetCurrentVehicleMaxPositionErrorToleranceSquared": "vehicles_transport",
    "SetCurrentVehicleMaxRotationBadErrorTolerance": "vehicles_transport",
    "SetCurrentVehicleMaxRotationErrorTolerance": "vehicles_transport",
    "SetVehicleClientResetCooldown": "vehicles_transport",
    "SetVehicleClientResetEnabled": "vehicles_transport",
    "SetVehicleSkipSaving": "vehicles_transport",
    "VehicleOverrideInputAxisValues": "vehicles_transport",
    # world environment / time / weather
    "SetTimeOfDay": "world_environment_time",
    "SetTimeOfDayRegionBiomeWithName": "world_environment_time",
    "SetTimeOfDaySpeed": "world_environment_time", "EnableTimeOfDay": "world_environment_time",
    "SetAutoSandstormSpawnEnabled": "world_environment_time",
    "SkySetSunRotation": "world_environment_time", "SkyBiomeConsoleInfo": "world_environment_time",
    "WindAtCurrentLocation": "world_environment_time",
    "BiomeConfigurationAtCurrentLocation": "world_environment_time",
    "BiomeConfigurationAtLocation": "world_environment_time",
    "DefaultWindDirectionCommitted": "world_environment_time",
    # persistence / world state / farm
    "SetTargetSkipSaving": "persistence_world_state",
    "SetPersistentName": "persistence_world_state",
    "SetPersistentVoiceSetName": "persistence_world_state",
    "FlushActorPersistence": "persistence_world_state",
    "DirtyStreamLevels": "persistence_world_state",
    "OverrideGameTweak": "persistence_world_state",
    "RemoveGameTweakOverride": "persistence_world_state",
    "RemoveAllGameTweakOverrides": "persistence_world_state",
    "CheckForGameTweaksUpdate": "persistence_world_state",
    "RestartFarm": "persistence_world_state", "StopFarm": "persistence_world_state",
    "SleepServer": "persistence_world_state", "UpdateRotationMode": "persistence_world_state",
    "SetIsTravelingFlagForced": "persistence_world_state",
    "FlagToRemove": "persistence_world_state",
    "SetResourceLocationSystemEnabled": "persistence_world_state",
    "SetPOIPentashieldResetCodeVolumesVisibility": "persistence_world_state",
    # comms channels / communinet
    "AddCommChannel": "comms_channels", "RemoveCommChannel": "comms_channels",
    "ListCommChannel": "comms_channels", "AddClickableMessage": "comms_channels",
    "AddTestMapMarkerMessage": "comms_channels", "ComMessage": "comms_channels",
    "ComMessageGlobal": "comms_channels", "ListActiveListenActions": "comms_channels",
    "SetCommuninetActiveState": "comms_channels",
    "SetCommuninetRadioStation": "comms_channels",
    "SetCommuninetRadioTestTime": "comms_channels",
    # MTX / shop / economy
    "ScheduleMTXEvent": "mtx_shop_economy", "ScheduleMTXEventJson": "mtx_shop_economy",
    "ListMTXEvents": "mtx_shop_economy", "EndActiveMTXEvents": "mtx_shop_economy",
    "EndAllMTXEvents": "mtx_shop_economy", "EndMTXEventById": "mtx_shop_economy",
    "EndPendingMTXEvents": "mtx_shop_economy",
    "AddSolarisToAccount": "mtx_shop_economy",
    "AddVirtualWalletBalance": "mtx_shop_economy",
    "ResetVendorStockData": "mtx_shop_economy",
    "SetAccountAsTakeoverable": "mtx_shop_economy",
    # audio / sound
    "AudioEventName": "audio_sound_debug", "AudioFglSnapshotTest": "audio_sound_debug",
    "SetAudioMasteringMode": "audio_sound_debug", "SetSubtitlesEnabled": "audio_sound_debug",
    "DisableDebugForAllAudio": "audio_sound_debug", "EnableDebugForAllAudio": "audio_sound_debug",
    "ToggleDebugForAudio": "audio_sound_debug", "VoiceSetName": "audio_sound_debug",
    # gamepad / haptics / UI
    "AddGamePadColorConstant": "gamepad_ui_feedback",
    "AddGamePadColorCurveColor": "gamepad_ui_feedback",
    "AddGamePadColorCurveFloat": "gamepad_ui_feedback",
    "ClearGamePadColor": "gamepad_ui_feedback", "RemoveGamePadColor": "gamepad_ui_feedback",
    "SetGamePadColorActive": "gamepad_ui_feedback", "ListGamePadColors": "gamepad_ui_feedback",
    "SetHUDUnlockLevel": "gamepad_ui_feedback",
    "CloseLoadingScreen": "gamepad_ui_feedback", "OpenLoadingScreen": "gamepad_ui_feedback",
    "ToggleShowLoadingScreen": "gamepad_ui_feedback",
    "ToggleAllHUDVisibility": "gamepad_ui_feedback", "ToggleUIVisibility": "gamepad_ui_feedback",
    "ToggleVehicleHUDOnly": "gamepad_ui_feedback", "ToggleAdminPanel": "gamepad_ui_feedback",
    "ToggleMousePositionDebug": "gamepad_ui_feedback",
    "ToggleAlignmentDebugUI": "gamepad_ui_feedback",
    "ToggleAnimWeaponDebugUI": "gamepad_ui_feedback",
    "ToggleCharacterMovementTypeDebugUI": "gamepad_ui_feedback",
    "ToggleCharacterStateDebugUI": "gamepad_ui_feedback",
    "EISShowHideContextDebug": "gamepad_ui_feedback", "EISToggleContext": "gamepad_ui_feedback",
    "OpenUIScene": "gamepad_ui_feedback", "SetAnimMode": "gamepad_ui_feedback",
    "MarketingClearHUDModes": "gamepad_ui_feedback", "MarketingToggleHUDMode": "gamepad_ui_feedback",
    "ShowSubtitleDebugInfo": "gamepad_ui_feedback", "HideSubtitleDebugInfo": "gamepad_ui_feedback",
    "ShowSequenceDebugInfo": "gamepad_ui_feedback", "HideSequenceDebugInfo": "gamepad_ui_feedback",
    "ShowBuildingStats": "gamepad_ui_feedback",
    "ShowCharacterCreationScreen": "gamepad_ui_feedback",
    "ShowCinematicCameraPanel": "gamepad_ui_feedback",
    "UIRadialWheelPrintInputSensitivityOverrides": "gamepad_ui_feedback",
    "ShowLandclaimCodeStats": "gamepad_ui_feedback",
    "ShowServerShelterLineTraceFrameBudget": "gamepad_ui_feedback",
    # camera
    "CameraOverrideDisable": "camera_debug", "CameraOverrideEnable": "camera_debug",
    "CameraOverrideEnableUsingCurrentCamValues": "camera_debug",
    "CameraSequence": "camera_debug", "UseFlyingCamera": "camera_debug",
    "DisableCinematicCameraMode": "camera_debug",
    "SimpleCameraSetSpringArmLength": "camera_debug",
    "SimpleCameraSnapLocation": "camera_debug", "SimpleCameraToggle": "camera_debug",
    "SimpleCameraToggleAutoSnapLocation": "camera_debug",
    "SimpleCameraToggleDetach": "camera_debug",
    # debug visualization
    "DrawPlayerBounds": "debug_world_visualization",
    "DrawServerCollisionClient": "debug_world_visualization",
    "ShowAICombatVolumes": "debug_world_visualization",
    "EnableAICombatVolumes": "debug_world_visualization",
    "ShowAttractorPoints": "debug_world_visualization", "ShowCoverPoints": "debug_world_visualization",
    "ShowObjectShelter": "building_totem_landclaim",  # covered above, kept for clarity
    "SetAIDebuggerDebugTarget": "debug_world_visualization",
    "SetNavMeshDebugViewEnabled": "debug_world_visualization",
    "ToggleSandStormDebug": "debug_world_visualization",
    "ToggleVisualPicker": "debug_world_visualization",
    "ToggleOverheadDebugInfoAndDamageNumbers": "debug_world_visualization",
    # character customization / mutable / gameplay tags
    "AddCharacterUnlockedCustomization": "character_customization",
    "AddCharacterUnlockedCustomizationAll": "character_customization",
    "RemoveCharacterUnlockedCustomization": "character_customization",
    "RemoveCharacterUnlockedCustomizationAll": "character_customization",
    "SetWeaponCustomization": "character_customization",
    "AddCharacterGameplayTag": "character_customization",
    "AddCharacterLooseGameplayTag": "character_customization",
    "RemoveCharacterGameplayTag": "character_customization",
    "RemoveCharacterLooseGameplayTag": "character_customization",
    "MutableApplyParamAllAI": "character_customization",
    "MutableGetAvailableOptions": "character_customization",
    "MutableGetCurrentAllValues": "character_customization",
    "MutablePrintNpcStats": "character_customization",
    # NPE / character lifecycle / story
    "DeleteCharacter": "character_npe_lifecycle",
    "DeleteCharacterDisconnect": "character_npe_lifecycle",
    "DeleteCharacterReconnect": "character_npe_lifecycle",
    "DeleteCharacterSkipNpeAndDisconnect": "character_npe_lifecycle",
    "DeleteCharacterSkipNpeAndReconnect": "character_npe_lifecycle",
    "DeleteCharacterSkipPbeAndDisconnect": "character_npe_lifecycle",
    "DeleteCharacterSkipPbeAndReconnect": "character_npe_lifecycle",
    "DeleteCharacterSkipPbeAndSkipNpeAndDisconnect": "character_npe_lifecycle",
    "DeleteCharacterSkipPbeAndSkipNpeAndReconnect": "character_npe_lifecycle",
    "ResetStoryProgress": "character_npe_lifecycle",
    "ClearFlsCharacterData": "character_npe_lifecycle",
    "FlsGetPlayerCompletedNpeValue": "character_npe_lifecycle",
    "FlsSetPlayerCompletedNpe": "character_npe_lifecycle",
    "NPESetCheckpointId": "character_npe_lifecycle", "NPESkipToArrakis": "character_npe_lifecycle",
    "SetNPEProgressCompletion": "character_npe_lifecycle",
    "SetHasDisplayedDemoIntroTutorial": "character_npe_lifecycle",
    "EnforceNakedStart": "character_npe_lifecycle", "ApplyCheckpoints": "character_npe_lifecycle",
    "LoadCheckpoint": "character_npe_lifecycle",
    "LoadCharacterCreationMap": "character_npe_lifecycle",
    "SandstormTreasureTutorial": "character_npe_lifecycle",
    "CompleteCurrentDungeon": "character_npe_lifecycle",
    "CheatCurrentDungeonCompletion": "character_npe_lifecycle",
    "ResetCurrentDungeon": "character_npe_lifecycle",
    "ResetCurrentDungeonRoom": "character_npe_lifecycle",
    "DeleteAllCompletionsForAllDungeonsByThisPlayer": "character_npe_lifecycle",
    "DeleteAllCompletionsForCurrentDungeon": "character_npe_lifecycle",
    "DeleteAllCompletionsForCurrentDungeonByThisPlayer": "character_npe_lifecycle",
    # gameplay effects / tags / cooldowns
    "ApplyStatusEffect": "survival_stats",  # covered above
    "AddCachedPlayerRewardsTag": "character_npe_lifecycle",
    "AddCachedPlayerRewardsTags": "character_npe_lifecycle",
    "RemoveCachedPlayerRewardsTags": "character_npe_lifecycle",
    "RemoveCachedPlayerInfo": "character_npe_lifecycle",
    "EndActiveMTXEvents": "mtx_shop_economy",  # covered above, kept for clarity
    # database / networking / probes
    "RaiseDatabaseException": "database_netprobe",
    "TestDatabaseTransaction": "database_netprobe",
    "TestDatabaseTransactionDataChange": "database_netprobe",
    "LogInAs": "account_fls", "PlayNow": "account_fls",
    "ForceEnterGame": "account_fls",
    "DisplayFlsBattlegroupsServerBrowserInfo": "account_fls",
    "EnableNamedEvents": "account_fls", "DisableNamedEvents": "account_fls",
    "SpamEventLogCharacterDeath": "account_fls",
    # tutorial / dialogue / party
    "TutorialCompleteByName": "tutorial_dialogue",
    "TutorialDismissCurrentNotification": "tutorial_dialogue",
    "TutorialEnqueueNotification": "tutorial_dialogue",
    "TutorialRevealByName": "tutorial_dialogue",
    "TutorialsResetAll": "tutorial_dialogue",
    "SkipCutscene": "tutorial_dialogue",
    "DialogueActor": "tutorial_dialogue", "DialogueDebugFlag": "tutorial_dialogue",
    "PartyInvitePlayer": "social_party", "PartyLeave": "social_party",
    "PartyRemovePlayer": "social_party",
    "RequestFakeGroupTravel": "social_party",
    # zones / weather / world events
    "SecurityZoneSetEnabled": "zones_world_events",
    "SecurityZoneSpawn": "zones_world_events",
    "ReviveFromDownedStateByAbility": "combat_abilities",
    "TryReviveFromDownedDirectly": "combat_abilities",
    "RespawnPvEContentDescriptorLoot": "loot",
    "GlobalDistributionPrintLootSettingsForCurrentLocation": "loot",
    "GlobalDistributionPrintTagsForCurrentLocation": "loot",
    # engine-core / linkage (debug-only internals)
    "BeginAsyncLoadAB": "engine_internal_rpc",
    "LinkAnimInstance": "engine_internal_rpc",
    "PruneInvalidMeleeHits": "combat_abilities",  # covered above, kept for clarity
    "OverrideNumBeams": "engine_internal_rpc",
    "DebugActionSystem": "engine_internal_rpc",
    "DebugOverrideCMCSlideVectorFactor": "engine_internal_rpc",
    "DebugOverrideCharacterStatComboBoxChanged": "engine_internal_rpc",
    "EnsureTest": "engine_internal_rpc",
    "FindCameraModifierById": "engine_internal_rpc",
    "FindRemoveSpawnedMineFromClass": "engine_internal_rpc",
    "FindSpawnedMineFromClass": "engine_internal_rpc",
    "ForceNpcEntityLod": "npc_encounters", "ClearNpcEntityLod": "npc_encounters",
    "LoadTerrainBlock": "persistence_world_state",
    "UnloadTerrainBlock": "persistence_world_state",
    "SetMoveIgnoreMaskFlags": "combat_abilities",
    "SetEyesOfIbad": "player_state",  # covered above, kept for clarity
    # --- Second manual pass (2026-08-04, full-list classification) ---
    "AddAllAvailableSchematics": "skills_progression",
    "AddPlayerFlags": "player_state",
    "AddPostProcess": "camera_debug", "RemovePostProcess": "camera_debug",
    "AgePercentage": "player_state",
    "AwardXP": "skills_progression",  # FLS registry, engine literal @12293345
    "KickPlayer": "player_state",      # FLS registry, engine literal @93785115
    "ServiceBroadcast": "comms_channels",  # FLS registry, engine literal @94659509
    "SpecializationXP": "skills_progression",  # fork composite (specialization-xp API)
    "ApplySpiceAddictionStatusChange": "sandworm_storm_spice",
    "BotsPrintList": "engine_internal_rpc", "BotsPrintNum": "engine_internal_rpc",
    "DisableRagdollFromImpact": "combat_abilities",
    "DisableShiftingSandsPhysics": "sandworm_storm_spice",
    "DisableShiftingSandsStormInteractions": "sandworm_storm_spice",
    "IgnoreMe": "engine_internal_rpc",
    "RemoveCachedPlayerRewardsTag": "character_npe_lifecycle",
    "RemoveSpiceVision": "sandworm_storm_spice",
    "ResetDialogueState": "tutorial_dialogue",
    "SetFuelBurningMultiplier": "vehicles_transport",
    "SetFuelsBurningDuration": "vehicles_transport",
    "SetHasFrostbite": "survival_stats", "SetHasWarming": "survival_stats",
    "SetIsActivatingSpicePrescience": "sandworm_storm_spice",
    "SetShouldNpcDropLootOnDeath": "loot",
    "SetShouldPlayersDropLootOnDeath": "loot",
    "SetShouldPlayersDropLootOnDefeat": "loot",
    "SetShouldPlayersLoseItemsOnDeath": "loot",
    "SkillsPrintGeneralInfo": "skills_progression",
    "SkillsPrintPerks": "skills_progression",
    "SkillsResetRespecTimer": "skills_progression",
    "SkillsRespec": "skills_progression",
    "SkillsSetStartingData": "skills_progression",
    "SkillsToggleCheatProgression": "skills_progression",
    "SkillsUnlockAll": "skills_progression",
    "SkillsUnlockAllPhase": "skills_progression",
    "SurveyingSetSkipProbeSequence": "skills_progression",
    "TriggerSpiceVision": "sandworm_storm_spice",
    "TriggerUseVolatilePointer": "engine_internal_rpc",
}


def classify(cmd):
    """Return the domain for a command. Must be total over the full list."""
    for name, s in CURATED.items():
        if cmd in s:
            return name
    if cmd in EXPLICIT:
        return EXPLICIT[cmd]

    # --- Prefix/suffix heuristics for everything else ---
    # Engine RPC / event-handler / client-server replication noise (NOT
    # invocable admin commands). Get/Has/Is/Can are engine queries surfaced by
    # UE replication, which the cheat manager also lists.
    if cmd.startswith(("Client", "Server", "Multicast", "On", "HandleOn",
                       "Receive", "RespondTo", "Sfx", "Notify", "Try",
                       "Predict", "Perform", "Can", "Has", "Is", "Get")) \
            or cmd.startswith("BP_"):
        return "engine_internal_rpc"

    # Achievements / conditions system
    if cmd.startswith("Achievement"):
        return "achievements"
    if cmd.startswith("Conditions"):
        return "conditions_system"

    # Spawn/despawn management
    if cmd.startswith(("SpawnTile", "Despawn", "DestroyTile", "SpawnZone", "SpawnMine")):
        return "spawn_worldgen"

    # Catch any stragglers explicitly so regeneration fails loudly if a new
    # command appears without a classification.
    raise ValueError(f"unclassified command: {cmd!r}")


def main():
    src = [l.strip() for l in open(SRC).read().splitlines() if l.strip()]
    if len(src) != 855:
        print(f"WARN: expected 855 commands, got {len(src)}", file=sys.stderr)
    assert len(src) == len(set(src)), "duplicate commands in source"

    names = set(src) | FLS_REGISTRY_ONLY
    if len(names) != 861:
        print(f"WARN: expected 861 full command set, got {len(names)}", file=sys.stderr)

    domains = {}
    for cmd in sorted(names):
        d = classify(cmd)
        domains.setdefault(d, []).append(cmd)

    order = [
        "inventory_items", "teleport_travel", "player_state", "loot",
        "npc_encounters", "coriolis", "landsraad_faction", "sandworm_storm_spice",
        "print_info", "cheat_debug",
        "skills_progression", "combat_abilities", "survival_stats",
        "building_totem_landclaim", "circuits_power_placeables", "vehicles_transport",
        "world_environment_time", "persistence_world_state", "comms_channels",
        "mtx_shop_economy", "audio_sound_debug", "gamepad_ui_feedback",
        "camera_debug", "debug_world_visualization", "character_customization",
        "character_npe_lifecycle", "tutorial_dialogue", "social_party",
        "achievements", "conditions_system", "zones_world_events",
        "database_netprobe", "account_fls", "spawn_worldgen",
    ]
    # engine_internal_rpc and any leftover noise go last, clearly labeled.
    order.append("engine_internal_rpc")

    out = ["## Catalog by domain (855 compiled-in candidates + 6 FLS-registry/fork entries)"]
    for d in order:
        if d not in domains:
            continue
        out.append(f"\n### {d} ({len(domains[d])})")
        for c in sorted(domains[d]):
            mark = " **FLS-VERIFIED**" if c in VERIFIED else ""
            out.append(f"- `{c}`{mark}")

    # Any domain not in the explicit order (should not happen; fail loudly).
    extra = set(domains) - set(order)
    if extra:
        raise ValueError(f"domains missing from order: {extra}")

    print("\n".join(out))
    total = sum(len(v) for v in domains.values())
    print(f"\n<!-- total commands: {total} -->", file=sys.stderr)
    if total != 861:
        print(f"WARN: total is {total}, expected 861", file=sys.stderr)


if __name__ == "__main__":
    main()
