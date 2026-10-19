--[[
    StorageBooster - FS25
    Author: Anthony

    Selectively boost individual placeable storage capacities.
    Use console commands to scan, pick, and boost only what you want.

    Console commands (open console with ~ key):
        sbScan           - List all placeables with storages (shows ID numbers)
        sbBoost <ID> <M> - Boost placeable #ID by Mx (e.g. sbBoost 3 10)
        sbReset <ID>     - Reset placeable #ID to original capacity
        sbResetAll       - Reset all placeables to original
        sbStatus         - Show all currently boosted placeables
]]

StorageBooster = {
    modDir = g_currentModDirectory,
    modName = g_currentModName,
    placeables = {},     -- indexed list built on scan: { {placeable=..., name=..., farmId=...}, ... }
    originals = {},      -- original capacities keyed by placeable index
    boosts = {},         -- active boosts keyed by placeable index: { multiplier=N }
}

-- ============================================================
-- Scanning - build a list of all placeables with storages
-- ============================================================

function StorageBooster:scanPlaceables()
    self.placeables = {}

    if g_currentMission == nil then
        return
    end

    local allPlaceables = {}

    if g_currentMission.placeableSystem ~= nil then
        for _, p in pairs(g_currentMission.placeableSystem.placeables or {}) do
            table.insert(allPlaceables, p)
        end
    end

    for _, placeable in ipairs(allPlaceables) do
        if self:hasStorage(placeable) then
            local name = self:getPlaceableName(placeable)
            local farmId = placeable.ownerFarmId or "?"
            table.insert(self.placeables, {
                placeable = placeable,
                name = name,
                farmId = farmId
            })
        end
    end
end

function StorageBooster:hasStorage(placeable)
    -- Check spec_silo
    if placeable.spec_silo ~= nil and placeable.spec_silo.storages ~= nil then
        for _ in pairs(placeable.spec_silo.storages) do return true end
    end
    -- Check generic storages
    if placeable.storages ~= nil then
        for _ in pairs(placeable.storages) do return true end
    end
    -- Check husbandry specs
    if placeable.spec_husbandryFood ~= nil and placeable.spec_husbandryFood.fillCapacity ~= nil then return true end
    if placeable.spec_husbandryStraw ~= nil and placeable.spec_husbandryStraw.fillCapacity ~= nil then return true end
    if placeable.spec_husbandryWater ~= nil and placeable.spec_husbandryWater.fillCapacity ~= nil then return true end
    if placeable.spec_husbandryMilk ~= nil and placeable.spec_husbandryMilk.fillCapacity ~= nil then return true end
    if placeable.spec_husbandryLiquidManure ~= nil and placeable.spec_husbandryLiquidManure.fillCapacity ~= nil then return true end
    if placeable.spec_husbandryManure ~= nil and placeable.spec_husbandryManure.fillCapacity ~= nil then return true end
    return false
end

function StorageBooster:getPlaceableName(placeable)
    -- Try storeItem name
    if placeable.storeItem ~= nil and placeable.storeItem.name ~= nil then
        return placeable.storeItem.name
    end
    -- Try configFileName
    if placeable.configFileName ~= nil then
        local name = placeable.configFileName:match("([^/\\]+)%.xml$")
        if name ~= nil then return name end
    end
    -- Try typeName
    if placeable.typeName ~= nil then
        return placeable.typeName
    end
    return "Unknown"
end

-- ============================================================
-- Save/restore original capacities for a specific placeable
-- ============================================================

function StorageBooster:saveOriginals(idx)
    if self.originals[idx] ~= nil then
        return -- already saved
    end

    local entry = self.placeables[idx]
    if entry == nil then return end
    local placeable = entry.placeable

    local orig = { storages = {}, specs = {} }

    -- Silo storages
    if placeable.spec_silo ~= nil and placeable.spec_silo.storages ~= nil then
        for si, storage in pairs(placeable.spec_silo.storages) do
            if storage.capacities ~= nil then
                orig.storages[si] = {}
                for fillTypeIdx, cap in pairs(storage.capacities) do
                    orig.storages[si][fillTypeIdx] = cap
                end
            end
        end
    end

    -- Generic storages
    if placeable.storages ~= nil then
        for si, storage in pairs(placeable.storages) do
            if storage.capacities ~= nil then
                if orig.storages[si] == nil then
                    orig.storages[si] = {}
                end
                for fillTypeIdx, cap in pairs(storage.capacities) do
                    if orig.storages[si][fillTypeIdx] == nil then
                        orig.storages[si][fillTypeIdx] = cap
                    end
                end
            end
        end
    end

    -- Husbandry specs
    local specNames = {"spec_husbandryFood", "spec_husbandryStraw", "spec_husbandryWater",
                       "spec_husbandryMilk", "spec_husbandryLiquidManure", "spec_husbandryManure"}
    for _, specName in ipairs(specNames) do
        if placeable[specName] ~= nil and placeable[specName].fillCapacity ~= nil then
            orig.specs[specName] = placeable[specName].fillCapacity
        end
    end

    self.originals[idx] = orig
end

-- ============================================================
-- Boost / Reset a specific placeable
-- ============================================================

function StorageBooster:boostPlaceable(idx, multiplier)
    local entry = self.placeables[idx]
    if entry == nil then
        return false, "Invalid ID"
    end

    self:saveOriginals(idx)
    local orig = self.originals[idx]
    local placeable = entry.placeable

    -- Boost silo storages
    if placeable.spec_silo ~= nil and placeable.spec_silo.storages ~= nil then
        for si, storage in pairs(placeable.spec_silo.storages) do
            if storage.capacities ~= nil and orig.storages[si] ~= nil then
                for fillTypeIdx, origCap in pairs(orig.storages[si]) do
                    storage.capacities[fillTypeIdx] = origCap * multiplier
                end
            end
        end
    end

    -- Boost generic storages
    if placeable.storages ~= nil then
        for si, storage in pairs(placeable.storages) do
            if storage.capacities ~= nil and orig.storages[si] ~= nil then
                for fillTypeIdx, origCap in pairs(orig.storages[si]) do
                    storage.capacities[fillTypeIdx] = origCap * multiplier
                end
            end
        end
    end

    -- Boost husbandry specs
    for specName, origCap in pairs(orig.specs) do
        if placeable[specName] ~= nil then
            placeable[specName].fillCapacity = origCap * multiplier
        end
    end

    self.boosts[idx] = { multiplier = multiplier }
    return true
end

function StorageBooster:resetPlaceable(idx)
    local entry = self.placeables[idx]
    if entry == nil then
        return false, "Invalid ID"
    end

    local orig = self.originals[idx]
    if orig == nil then
        return false, "Not boosted"
    end

    local placeable = entry.placeable

    -- Restore silo storages
    if placeable.spec_silo ~= nil and placeable.spec_silo.storages ~= nil then
        for si, storage in pairs(placeable.spec_silo.storages) do
            if storage.capacities ~= nil and orig.storages[si] ~= nil then
                for fillTypeIdx, origCap in pairs(orig.storages[si]) do
                    storage.capacities[fillTypeIdx] = origCap
                end
            end
        end
    end

    -- Restore generic storages
    if placeable.storages ~= nil then
        for si, storage in pairs(placeable.storages) do
            if storage.capacities ~= nil and orig.storages[si] ~= nil then
                for fillTypeIdx, origCap in pairs(orig.storages[si]) do
                    storage.capacities[fillTypeIdx] = origCap
                end
            end
        end
    end

    -- Restore husbandry specs
    for specName, origCap in pairs(orig.specs) do
        if placeable[specName] ~= nil then
            placeable[specName].fillCapacity = origCap
        end
    end

    self.boosts[idx] = nil
    self.originals[idx] = nil
    return true
end

-- ============================================================
-- Format fill type info for display
-- ============================================================

function StorageBooster:getStorageDetails(placeable, origData)
    local lines = {}

    -- Silo storages
    if placeable.spec_silo ~= nil and placeable.spec_silo.storages ~= nil then
        for si, storage in pairs(placeable.spec_silo.storages) do
            if storage.capacities ~= nil then
                for fillTypeIdx, cap in pairs(storage.capacities) do
                    local fillType = g_fillTypeManager:getFillTypeByIndex(fillTypeIdx)
                    local name = fillType ~= nil and fillType.title or ("FillType#" .. fillTypeIdx)
                    local origCap = origData ~= nil and origData.storages[si] ~= nil and origData.storages[si][fillTypeIdx]
                    if origCap ~= nil and origCap ~= cap then
                        table.insert(lines, ("      %s: %d -> %d"):format(name, origCap, cap))
                    else
                        table.insert(lines, ("      %s: %d"):format(name, cap))
                    end
                end
            end
        end
    end

    -- Husbandry specs
    local specLabels = {
        spec_husbandryFood = "Food",
        spec_husbandryStraw = "Straw",
        spec_husbandryWater = "Water",
        spec_husbandryMilk = "Milk",
        spec_husbandryLiquidManure = "Slurry",
        spec_husbandryManure = "Manure"
    }
    for specName, label in pairs(specLabels) do
        if placeable[specName] ~= nil and placeable[specName].fillCapacity ~= nil then
            local cap = placeable[specName].fillCapacity
            local origCap = origData ~= nil and origData.specs[specName]
            if origCap ~= nil and origCap ~= cap then
                table.insert(lines, ("      %s: %d -> %d"):format(label, origCap, cap))
            else
                table.insert(lines, ("      %s: %d"):format(label, cap))
            end
        end
    end

    return lines
end

-- ============================================================
-- Game event listeners
-- ============================================================

function StorageBooster:loadMap(name)
    addConsoleCommand("sbScan", "Scan and list all placeables with storages", "consoleScan", self)
    addConsoleCommand("sbBoost", "Boost a placeable. Usage: sbBoost <ID> <multiplier>", "consoleBoost", self)
    addConsoleCommand("sbReset", "Reset a placeable. Usage: sbReset <ID>", "consoleReset", self)
    addConsoleCommand("sbResetAll", "Reset all placeables to original capacity", "consoleResetAll", self)
    addConsoleCommand("sbStatus", "Show all currently boosted placeables", "consoleStatus", self)
end

function StorageBooster:loadMapFinished()
    print("[StorageBooster] Ready. Use 'sbScan' to list placeables, then 'sbBoost <ID> <multiplier>' to boost.")
end

function StorageBooster:deleteMap()
    removeConsoleCommand("sbScan")
    removeConsoleCommand("sbBoost")
    removeConsoleCommand("sbReset")
    removeConsoleCommand("sbResetAll")
    removeConsoleCommand("sbStatus")
    self.placeables = {}
    self.originals = {}
    self.boosts = {}
end

-- ============================================================
-- Console commands
-- ============================================================

function StorageBooster:consoleScan()
    self:scanPlaceables()

    if #self.placeables == 0 then
        return "No placeables with storages found."
    end

    local lines = { "[StorageBooster] Found placeables:" }
    table.insert(lines, "--------------------------------------------")

    for idx, entry in ipairs(self.placeables) do
        local boostInfo = ""
        if self.boosts[idx] ~= nil then
            boostInfo = (" [BOOSTED %dx]"):format(self.boosts[idx].multiplier)
        end
        table.insert(lines, ("#%d  Farm:%s  %s%s"):format(idx, tostring(entry.farmId), entry.name, boostInfo))

        local details = self:getStorageDetails(entry.placeable, self.originals[idx])
        for _, line in ipairs(details) do
            table.insert(lines, line)
        end
    end

    table.insert(lines, "--------------------------------------------")
    table.insert(lines, "Use: sbBoost <ID> <multiplier>  (e.g. sbBoost 3 10)")

    local result = table.concat(lines, "\n")
    print(result)
    return result
end

function StorageBooster:consoleBoost(idStr, multStr)
    local idx = tonumber(idStr)
    local mult = tonumber(multStr)

    if idx == nil or mult == nil or mult < 1 then
        return "Usage: sbBoost <ID> <multiplier>  (e.g. sbBoost 3 10). Run sbScan first."
    end

    if #self.placeables == 0 then
        self:scanPlaceables()
    end

    mult = math.floor(mult)
    local ok, err = self:boostPlaceable(idx, mult)
    if not ok then
        return "Error: " .. tostring(err)
    end

    local entry = self.placeables[idx]
    return ("Boosted #%d '%s' (Farm %s) by %dx"):format(idx, entry.name, tostring(entry.farmId), mult)
end

function StorageBooster:consoleReset(idStr)
    local idx = tonumber(idStr)
    if idx == nil then
        return "Usage: sbReset <ID>"
    end

    local ok, err = self:resetPlaceable(idx)
    if not ok then
        return "Error: " .. tostring(err)
    end

    local entry = self.placeables[idx]
    return ("Reset #%d '%s' to original capacity"):format(idx, entry.name)
end

function StorageBooster:consoleResetAll()
    local count = 0
    for idx in pairs(self.boosts) do
        self:resetPlaceable(idx)
        count = count + 1
    end
    return ("Reset %d placeables to original capacity"):format(count)
end

function StorageBooster:consoleStatus()
    if next(self.boosts) == nil then
        return "No placeables are currently boosted. Use sbScan then sbBoost."
    end

    local lines = { "[StorageBooster] Currently boosted:" }
    for idx, boost in pairs(self.boosts) do
        local entry = self.placeables[idx]
        if entry ~= nil then
            lines[#lines+1] = ("#%d  Farm:%s  %s  [%dx]"):format(idx, tostring(entry.farmId), entry.name, boost.multiplier)
            local details = self:getStorageDetails(entry.placeable, self.originals[idx])
            for _, line in ipairs(details) do
                table.insert(lines, line)
            end
        end
    end

    local result = table.concat(lines, "\n")
    print(result)
    return result
end

addModEventListener(StorageBooster)
