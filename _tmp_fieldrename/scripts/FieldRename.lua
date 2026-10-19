--
-- FieldRename
-- Adds a "Rename" action to the farmland context box in the map overlay
--

source(g_currentModDirectory .. "scripts/FieldRenameEvent.lua")

FieldRename = {}
FieldRename.MOD_NAME = g_currentModName
FieldRename.MOD_DIR = g_currentModDirectory

-- Storage for custom field names: fieldId -> string
FieldRename.fieldNames = {}

-- Store reference to the map frame (used for updating context box after rename)
FieldRename.mapFrame = nil

-- Action index stored after injection
local RENAME_ACTION_INDEX = nil

-- Max display length for field names on map (to prevent overlap)
local MAX_HOTSPOT_NAME_LENGTH = 12

-- Truncate a name for map hotspot display
local function truncateForHotspot(name)
    if name == nil or name == "" then
        return name
    end
    if utf8Strlen(name) > MAX_HOTSPOT_NAME_LENGTH then
        return utf8Substr(name, 0, MAX_HOTSPOT_NAME_LENGTH - 1) .. "…"
    end
    return name
end

---
-- Public API for other mods to detect and use FieldRename
---

--- Check if FieldRename mod is loaded (for other mods to detect)
---@return boolean
function FieldRename.isLoaded()
    return true
end

--- Get custom field name for a field ID
---@param fieldId number The farmland ID
---@return string|nil The custom name, or nil if not set
function FieldRename.getFieldName(fieldId)
    return FieldRename.fieldNames[fieldId]
end

--- Show the rename dialog for a specific field
--- Can be called by other mods (e.g., CropRotation) to add rename functionality
---@param fieldId number The farmland ID to rename
---@param currentName string|nil Optional current name to show in dialog
function FieldRename.showRenameDialog(fieldId, currentName)
    if fieldId == nil then
        return
    end

    -- Use custom name if set, otherwise default to "Field X"
    local displayName = currentName or FieldRename.fieldNames[fieldId]
    if displayName == nil or displayName == "" then
        displayName = string.format(g_i18n:getText("contract_field_name"), fieldId)
    end
    local dialogPrompt = g_i18n:getText("ui_enterFieldName")
    local imePrompt = g_i18n:getText("ui_enterFieldName")
    local confirmText = g_i18n:getText("button_ok")

    -- Defer by one frame to ensure focus works correctly when opening from map context menu
    g_currentMission:addUpdateable({
        update = function(self, dt)
            g_currentMission:removeUpdateable(self)
            TextInputDialog.show(
                FieldRename.onRenameDialogCallback,  -- callback
                FieldRename,                          -- target
                displayName,                          -- defaultText
                dialogPrompt,                         -- dialogPrompt
                imePrompt,                            -- imePrompt
                50,                                   -- maxCharacters
                confirmText,                          -- confirmText
                fieldId,                              -- callbackArgs (passed to callback)
                nil,                                  -- text
                true                                  -- applyTextFilter
            )
            -- Second frame: force focus after dialog is fully open
            g_currentMission:addUpdateable({
                update = function(self2, dt2)
                    g_currentMission:removeUpdateable(self2)
                    local dialog = TextInputDialog.INSTANCE
                    if dialog ~= nil and dialog.textElement ~= nil then
                        dialog.textElement.blockTime = 0
                        FocusManager:setFocus(dialog.textElement)
                        dialog.textElement:onFocusActivate()
                    end
                end
            })
        end
    })
end

--- Callback when rename dialog is confirmed
function FieldRename.onRenameDialogCallback(self, text, clickOk, fieldId)
    if clickOk and fieldId then
        FieldRename.setFieldName(fieldId, text)

        -- Update the context box title immediately if it's still visible
        -- Use contextBoxFarmland specifically for farmland context boxes
        if FieldRename.mapFrame ~= nil then
            local contextBox = FieldRename.mapFrame.contextBoxFarmland
            if contextBox ~= nil and contextBox:getIsVisible() then
                local textElement = contextBox:getDescendantByName("text")
                if textElement then
                    local newName = text
                    if newName == nil or newName == "" then
                        -- Reverted to default - show "Farmland: <farmland.name>" like the base game
                        local farmland = FieldRename.mapFrame.selectedFarmland
                        if farmland then
                            newName = g_i18n:getText("fieldInfo_farmland") .. ": " .. farmland.name
                        else
                            newName = g_i18n:getText("fieldInfo_farmland")
                        end
                    end
                    textElement:setText(newName)
                end
            end
        end
    end
end

---
-- Hook onLoadMapFinished to inject our action (same pattern as PF)
local originalOnLoadMapFinished = InGameMenuMapFrame.onLoadMapFinished
InGameMenuMapFrame.onLoadMapFinished = function(self)
    -- Call original first
    originalOnLoadMapFinished(self)

    -- Store reference for later use
    FieldRename.mapFrame = self

    -- Add our rename action using table.insert (like PF does)
    -- The callback receives the frame as first argument when invoked
    table.insert(self.contextActions, {
        title = g_i18n:getText("button_rename"),
        callback = function(frame)
            FieldRename.onClickRenameFarmland(frame)
            return true
        end,
        isActive = false
    })
    RENAME_ACTION_INDEX = #self.contextActions
end

-- Hook setMapInputContext to enable rename button when farmland is owned
local originalSetMapInputContext = InGameMenuMapFrame.setMapInputContext
InGameMenuMapFrame.setMapInputContext = function(self, canEnter, canReset, canSellVehicle, canVisit, canSetMarker, removeMarker, canBuy, canSell, canManage)
    -- Call original
    originalSetMapInputContext(self, canEnter, canReset, canSellVehicle, canVisit, canSetMarker, removeMarker, canBuy, canSell, canManage)

    -- Enable rename when we can sell (i.e., player owns the farmland)
    -- canSell is true when the player owns the farmland and has farmManager permission
    if RENAME_ACTION_INDEX and self.contextActions and self.contextActions[RENAME_ACTION_INDEX] then
        self.contextActions[RENAME_ACTION_INDEX].isActive = canSell
    end
end

-- Callback when rename button is clicked in map overlay
function FieldRename.onClickRenameFarmland(frame)
    if frame == nil then
        return
    end

    local farmland = frame.selectedFarmland
    if farmland == nil then
        return
    end

    local fieldId = farmland.id

    -- Use the public API which handles the dialog correctly
    FieldRename.showRenameDialog(fieldId)
end

-- Helper to set field name and save (with optional network sync)
---@param fieldId number The farmland ID
---@param name string|nil The custom name
---@param noSync boolean|nil If true, don't send network event (used when receiving from network)
function FieldRename.setFieldName(fieldId, name, noSync)
    if name and name ~= "" then
        FieldRename.fieldNames[fieldId] = name
    else
        FieldRename.fieldNames[fieldId] = nil
    end

    -- Update the map hotspot immediately
    FieldRename.updateHotspotName(fieldId, name)

    -- Sync to other players in multiplayer
    if not noSync and g_currentMission.missionDynamicInfo.isMultiplayer then
        FieldRenameEvent.sendEvent(fieldId, name)
    end
end

-- Update the map hotspot name for a field
---@param fieldId number The farmland ID
---@param name string|nil The custom name (nil to revert to default)
function FieldRename.updateHotspotName(fieldId, name)
    local farmland = g_farmlandManager:getFarmlandById(fieldId)
    if farmland and farmland.mapHotspot then
        if name and name ~= "" then
            farmland.mapHotspot.name = truncateForHotspot(name)
            farmland.mapHotspot.hasCustomName = true
        else
            -- Revert to default farmland name
            farmland.mapHotspot.name = farmland:getName()
            farmland.mapHotspot.hasCustomName = false
            -- Reset icon width to default
            if farmland.mapHotspot.icon then
                farmland.mapHotspot.icon.width = farmland.mapHotspot.icon.height
            end
        end
    end
end

---
-- Hook InGameMenuMapUtil.showContextBox to replace farmland name with custom name
local originalShowContextBox = InGameMenuMapUtil.showContextBox
InGameMenuMapUtil.showContextBox = function(contextBox, hotspot, description, imageFilename, uvs, farmId, playerName, isPlaceable, isVehicle, isFarmland)
    -- Call original first
    originalShowContextBox(contextBox, hotspot, description, imageFilename, uvs, farmId, playerName, isPlaceable, isVehicle, isFarmland)

    -- If this is a farmland context box, check for custom name
    if isFarmland and contextBox ~= nil then
        local farmland = hotspot:getFarmland()
        if farmland ~= nil then
            local fieldId = farmland.id
            local customName = FieldRename.fieldNames[fieldId]

            if customName and customName ~= "" then
                -- Replace the title text with just the custom name (no "Farmland:" prefix)
                local text = contextBox:getDescendantByName("text")
                if text then
                    text:setText(customName)
                end
            end
        end
    end
end

---
-- Add helper function to InfoDisplayKeyValueBox to replace a line's value by key
function InfoDisplayKeyValueBox:replaceLineValue(key, newValue)
    for _, line in ipairs(self.lines) do
        if line.isActive and line.key == key then
            line.value = newValue or ""
            return true
        end
    end
    return false
end

---
-- Hook PlayerHUDUpdater:fieldAddFarmland to show custom field name in walking HUD
-- Light approach: let original run, then replace the value
local originalFieldAddFarmland = PlayerHUDUpdater.fieldAddFarmland
PlayerHUDUpdater.fieldAddFarmland = function(self, fieldInfo, box)
    -- Call original first
    originalFieldAddFarmland(self, fieldInfo, box)

    -- Check for custom field name and replace if found
    local fieldId = fieldInfo.farmlandId
    local customName = FieldRename.fieldNames[fieldId]

    if customName and customName ~= "" then
        box:replaceLineValue(g_i18n:getText("fieldInfo_farmland"), customName)
    end
end

---
-- Savegame persistence (uses separate fieldNames.xml file)
---

local SAVE_FILENAME = "fieldNames.xml"

local function getSavegameDir()
    if g_currentMission == nil or g_currentMission.missionInfo == nil then
        return nil
    end

    if g_currentMission.missionInfo.savegameDirectory ~= nil then
        return g_currentMission.missionInfo.savegameDirectory
    end

    if g_currentMission.missionInfo.savegameIndex ~= nil then
        return getUserProfileAppPath() .. "savegame" .. tostring(g_currentMission.missionInfo.savegameIndex)
    end

    return nil
end

-- Load field names from savegame
function FieldRename.loadFromSavegame()
    local savegameDir = getSavegameDir()
    if savegameDir == nil then
        return
    end

    local path = savegameDir .. "/" .. SAVE_FILENAME
    local xmlFile = XMLFile.loadIfExists("fieldNames", path)
    if xmlFile == nil then
        return
    end

    FieldRename.fieldNames = {}

    local i = 0
    while true do
        local key = string.format("fieldNames.field(%d)", i)
        if not xmlFile:hasProperty(key .. "#id") then
            break
        end

        local fieldId = xmlFile:getInt(key .. "#id")
        local fieldName = xmlFile:getString(key .. "#name")

        if fieldId ~= nil and fieldName ~= nil then
            FieldRename.fieldNames[fieldId] = fieldName
        end

        i = i + 1
    end

    xmlFile:delete()
end

-- Save field names to savegame
function FieldRename.saveToSavegame()
    local savegameDir = getSavegameDir()
    if savegameDir == nil then
        return
    end

    -- Don't save if no field names
    local hasNames = next(FieldRename.fieldNames) ~= nil
    if not hasNames then
        return
    end

    local path = savegameDir .. "/" .. SAVE_FILENAME
    local xmlFile = XMLFile.create("fieldNames", path, "fieldNames")
    if xmlFile == nil then
        return
    end

    local i = 0
    for fieldId, fieldName in pairs(FieldRename.fieldNames) do
        local key = string.format("fieldNames.field(%d)", i)
        xmlFile:setInt(key .. "#id", fieldId)
        xmlFile:setString(key .. "#name", fieldName)
        i = i + 1
    end

    xmlFile:save()
    xmlFile:delete()
end

-- Hook save
local function onSaveCareer(missionInfo)
    FieldRename.saveToSavegame()
end
FSCareerMissionInfo.saveToXMLFile = Utils.appendedFunction(FSCareerMissionInfo.saveToXMLFile, onSaveCareer)

local function onSaveMission(self, xmlFile, key, usedModNames)
    FieldRename.saveToSavegame()
end

if FSBaseMission ~= nil and FSBaseMission.saveToXMLFile ~= nil then
    FSBaseMission.saveToXMLFile = Utils.appendedFunction(FSBaseMission.saveToXMLFile, onSaveMission)
end

if Mission00 ~= nil and Mission00.saveToXMLFile ~= nil then
    Mission00.saveToXMLFile = Utils.appendedFunction(Mission00.saveToXMLFile, onSaveMission)
end

-- Hook load (after map is loaded)
local function onMissionLoaded(mission, node)
    FieldRename.loadFromSavegame()

    -- Update all existing hotspots with custom names (hotspots created before savegame loaded)
    FieldRename.updateAllHotspots()
end
FSBaseMission.loadMapFinished = Utils.appendedFunction(FSBaseMission.loadMapFinished, onMissionLoaded)

-- Update all farmland hotspots with custom names
function FieldRename.updateAllHotspots()
    if g_farmlandManager == nil then
        return
    end

    for fieldId, customName in pairs(FieldRename.fieldNames) do
        FieldRename.updateHotspotName(fieldId, customName)
    end
end

---
-- Multiplayer: Sync field names to clients when they join
-- Hook is installed when mission starts to ensure FSBaseMission is fully defined
---
local function installClientJoinHook()
    if FSBaseMission.sendInitialClientState ~= nil then
        local originalSendInitialClientState = FSBaseMission.sendInitialClientState
        FSBaseMission.sendInitialClientState = function(self, connection, user, farm)
            -- Call original first
            originalSendInitialClientState(self, connection, user, farm)

            -- If we're the server and have field names, sync them to the new client
            if g_server ~= nil then
                local hasNames = next(FieldRename.fieldNames) ~= nil
                if hasNames then
                    FieldRenameEvent.sendSyncAll(connection)
                end
            end
        end
    end
end

Mission00.onStartMission = Utils.appendedFunction(Mission00.onStartMission, installClientJoinHook)

---
-- Override FarmlandHotspot.setFarmland to use custom names on the map overlay
local originalSetFarmland = FarmlandHotspot.setFarmland
FarmlandHotspot.setFarmland = function(self, farmland)
    originalSetFarmland(self, farmland)
    if farmland ~= nil then
        local customName = FieldRename.fieldNames[farmland.id]
        if customName and customName ~= "" then
            self.name = truncateForHotspot(customName)
            self.hasCustomName = true
        else
            self.hasCustomName = false
        end
    end
end

---
-- Override FarmlandHotspot.render to scale icon width for custom names
local originalRender = FarmlandHotspot.render
FarmlandHotspot.render = function(self, x, y, rotation, small)
    -- For custom names, calculate and set icon width based on text
    if self.hasCustomName and self.icon ~= nil and self.name ~= "" then
        local textSize = self.textSize * (0.25 + self.scale * 0.75)
        setTextBold(true)
        local textWidth = getTextWidth(textSize, self.name)
        setTextBold(false)
        -- Add padding around text (scale-aware)
        local baseHeight = self.height  -- Original unscaled height
        local padding = baseHeight * self.scale * 0.5
        local minWidth = self.icon.height  -- At least as wide as tall
        self.icon.width = math.max(minWidth, textWidth + padding)
    end

    -- Call original render
    originalRender(self, x, y, rotation, small)
end
